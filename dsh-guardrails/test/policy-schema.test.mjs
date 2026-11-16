import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA,
  SUPPORTED_VERSION,
  describeErrors,
  errorSignature,
  validatePolicy,
} from '../lib/policy/validate.js';

/** The policy on disk today, minus the keys a user is free to leave out. */
const TODAY = {
  version: 1,
  enabled: true,
  auditDir: '~/.dsh/guardrails/audit',
  rules: {
    protectDshHome: { mode: 'ask', roots: ['~/.dsh', '~/.agents'] },
    destructive: {
      mode: 'ask',
      patterns: [],
      workspaceQuiet: {
        enabled: true,
        roots: ['D:\\work\\guardrails'],
        paths: ['_scratch', 'build'],
        alwaysAsk: ['.git'],
      },
    },
    secrets: { mode: 'ask', patterns: [] },
  },
};

/** Every default the merge can produce, before a user touches anything. */
const DEFAULTS_SHAPED = {
  enabled: true,
  audit: { format: 'v2', maxPayloadBytes: 64 * 1024 },
  rules: {
    protectDshHome: { mode: 'ask', roots: ['~/.dsh', '~/.agents'], alwaysAskTools: ['plugin_manager'] },
    critical: { mode: 'deny', patterns: [], failClosed: true },
    destructive: { mode: 'ask', patterns: [] },
    secrets: { mode: 'ask', patterns: [] },
    selfProtect: { mode: 'ask', paths: [] },
  },
};

const entry = () => ({
  id: 'a1',
  tool: ['pwsh'],
  mode: 'observe',
  when: { commandMatches: '^rm ' },
});

test('schema: the document itself keeps the strict shape', () => {
  assert.equal(SCHEMA.additionalProperties, false);
  assert.equal(SUPPORTED_VERSION, 1);
});

test('schema: empty, minimal, todays and defaults-shaped policies pass', () => {
  for (const policy of [{}, { version: 1 }, TODAY, DEFAULTS_SHAPED]) {
    const report = validatePolicy(policy);
    assert.equal(report.ok, true, `expected valid: ${JSON.stringify(policy)} -> ${describeErrors(report.errors)}`);
  }
});

test('schema: a full policy with quiet and self-protect passes', () => {
  const report = validatePolicy({
    ...TODAY,
    audit: { format: 'v2', maxPayloadBytes: 4096 },
    rules: {
      ...TODAY.rules,
      critical: { mode: 'ask', patterns: [], failClosed: false },
      selfProtect: { mode: 'deny', paths: ['D:\\work\\vendor\\dsh-guardrails'] },
    },
  });
  assert.equal(report.ok, true, describeErrors(report.errors));
});

test('schema: known-bad samples are rejected at the offending path', () => {
  const samples = [
    ['unknown top-level key', { extra: true }, 'extra', 'unknown-key'],
    ['typo inside rules', { rules: { destructiv: { mode: 'ask' } } }, 'rules.destructiv', 'unknown-key'],
    [
      'typo inside workspaceQuiet',
      { rules: { destructive: { workspaceQuiet: { enabled: true, alwaysAskk: [] } } } },
      'rules.destructive.workspaceQuiet.alwaysAskk',
      'unknown-key',
    ],
    ['allow under version 1', { version: 1, rules: { destructive: { mode: 'allow' } } }, 'rules.destructive.mode', 'allow-requires-v2'],
    ['version 3', { version: 3 }, 'version', 'unsupported-version'],
    ['version 2 before engine v2 lands', { version: 2 }, 'version', 'unsupported-version'],
    ['self-protect off', { rules: { selfProtect: { mode: 'off' } } }, 'rules.selfProtect.mode', 'enum'],
    ['self-protect allow', { rules: { selfProtect: { mode: 'allow' } } }, 'rules.selfProtect.mode', 'enum'],
    ['self-protect without mode', { rules: { selfProtect: { paths: [] } } }, 'rules.selfProtect.mode', 'required'],
    ['critical observe', { rules: { critical: { mode: 'observe' } } }, 'rules.critical.mode', 'enum'],
    ['patterns must be an array', { rules: { destructive: { patterns: 'rm' } } }, 'rules.destructive.patterns', 'type'],
    ['audit format unknown', { audit: { format: 'v3' } }, 'audit.format', 'enum'],
    ['maxPayloadBytes zero', { audit: { maxPayloadBytes: 0 } }, 'audit.maxPayloadBytes', 'minimum'],
    ['roots entry not a string', { rules: { protectDshHome: { roots: [42] } } }, 'rules.protectDshHome.roots[0]', 'type'],
    ['null rule slice', { rules: { protectDshHome: null } }, 'rules.protectDshHome', 'type'],
    ['entries require engine v2', { entries: [entry()] }, 'entries[0]', 'entries-require-v2'],
    [
      'allow entry without narrowing',
      { entries: [{ id: 'a1', tool: ['pwsh'], mode: 'allow' }] },
      'entries[0].when',
      'allow-needs-narrowing',
    ],
    [
      'entry with a relative path',
      { entries: [{ id: 'a1', tool: ['pwsh'], mode: 'ask', when: { cwdUnder: ['work'] } }] },
      'entries[0].when.cwdUnder[0]',
      'path-shape',
    ],
    [
      'entry with a dot-dot path',
      { entries: [{ id: 'a1', tool: ['pwsh'], mode: 'ask', when: { cwdUnder: ['D:\\work\\..\\other'] } }] },
      'entries[0].when.cwdUnder[0]',
      'path-shape',
    ],
    [
      'commandMatches unanchored',
      { entries: [{ id: 'a1', tool: ['pwsh'], mode: 'ask', when: { commandMatches: 'rm ' } }] },
      'entries[0].when.commandMatches',
      'command-matches-unanchored',
    ],
    [
      'commandMatches does not compile',
      { entries: [{ id: 'a1', tool: ['pwsh'], mode: 'ask', when: { commandMatches: '^a(' } }] },
      'entries[0].when.commandMatches',
      'command-matches-invalid',
    ],
    ['duplicate entry id', { entries: [entry(), entry()] }, 'entries[1].id', 'duplicate-id'],
    ['entry id shape', { entries: [{ id: 'A_1', tool: ['pwsh'], mode: 'ask' }] }, 'entries[0].id', 'pattern'],
    [
      'self-protect extra path relative',
      { rules: { selfProtect: { mode: 'ask', paths: ['vendor\\dsh-guardrails'] } } },
      'rules.selfProtect.paths[0]',
      'path-shape',
    ],
    [
      'self-protect extra path escapes',
      { rules: { selfProtect: { mode: 'ask', paths: ['D:\\work\\..\\vendor'] } } },
      'rules.selfProtect.paths[0]',
      'path-shape',
    ],
  ];

  for (const [label, sample, path, code] of samples) {
    const report = validatePolicy(sample);
    assert.equal(report.ok, false, `expected rejection: ${label}`);
    const hit = report.errors.find((error) => error.path === path && error.code === code);
    assert.ok(hit !== undefined, `${label}: no ${code} at ${path}, got ${describeErrors(report.errors)}`);
  }
});

test('schema: a rejected policy never produces an empty explanation', () => {
  const report = validatePolicy({ rules: { nope: {} } });
  assert.equal(report.ok, false);
  const text = describeErrors(report.errors);
  assert.match(text, /rules\.nope/);
  assert.match(text, /unknown key/);
});

test('schema: describeErrors caps the shown problems and counts the rest', () => {
  const errors = Array.from({ length: 5 }, (_, index) => ({
    path: `rules.x${index}`,
    code: 'unknown-key',
    message: 'unknown key "x"',
  }));
  const text = describeErrors(errors);
  assert.match(text, /rules\.x0/);
  assert.match(text, /\+2 more/);
  assert.doesNotMatch(text, /rules\.x4/);
});

test('schema: the dedupe signature is stable and problem-specific', () => {
  const a = validatePolicy({ extra: true }).errors;
  const b = validatePolicy({ more: true }).errors;
  assert.equal(errorSignature(a), errorSignature(a));
  assert.notEqual(errorSignature(a), errorSignature(b));
  assert.equal(errorSignature([]), '');
});
