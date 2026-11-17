/**
 * Engine v2: collect every band, rank, keep the strictest.
 * 引擎 v2：收集所有命中、排序、取最严。
 *
 * The point of these tests is the difference between "first hit wins" (v1) and
 * "strictest hit wins" (v2): with v2 a lower-ranked band can no longer hide a
 * stricter one, and a user entry can never outrank a red line.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../rules.js';
import { describe, LOCALES } from '../lib/describe.js';

const ENV = {
  USERPROFILE: 'C:\\Users\\Tester',
  HOME: 'C:\\Users\\Tester',
  DSH_HOME: 'C:\\Users\\Tester\\.dsh',
  AGENTS_HOME: 'C:\\Users\\Tester\\.agents',
};

const RULES = () => ({
  protectDshHome: { mode: 'ask', roots: ['~/.dsh', '~/.agents'], alwaysAskTools: ['plugin_manager'] },
  critical: { mode: 'deny', patterns: [], failClosed: true },
  destructive: { mode: 'ask', patterns: [] },
  secrets: { mode: 'ask', patterns: [] },
  selfProtect: { mode: 'ask', paths: [] },
});

const policyV2 = (overrides = {}) => ({
  version: 2,
  enabled: true,
  rules: { ...RULES(), ...(overrides.rules ?? {}) },
  ...(overrides.entries === undefined ? {} : { entries: overrides.entries }),
});

/** v1: no version key. v2: same rules, version 2. */
const policyV1 = (overrides = {}) => ({
  enabled: true,
  rules: { ...RULES(), ...(overrides.rules ?? {}) },
  ...(overrides.entries === undefined ? {} : { entries: overrides.entries }),
});

const call = (name, args) => ({ name, arguments: args });
const shell = (command) => call('pwsh', { command });

test('v1 output is untouched: same verdict object, no v2 keys', () => {
  const verdict = evaluate(policyV1(), shell('Remove-Item -Recurse D:\\work\\dist'), ENV);
  assert.equal(verdict.rule, 'R2');
  assert.equal(verdict.mode, 'ask');
  assert.equal(verdict.reasons, undefined);
  assert.equal(verdict.policyVersion, undefined);
  assert.equal(verdict.secretHit, undefined);
});

test('v2 winner carries reasons and the engine version', () => {
  const verdict = evaluate(policyV2(), shell('Remove-Item -Recurse D:\\work\\dist'), ENV);
  assert.equal(verdict.rule, 'R2');
  assert.equal(verdict.mode, 'ask');
  assert.equal(verdict.policyVersion, 2);
  assert.equal(verdict.secretHit, false);
  assert.ok(Array.isArray(verdict.reasons) && verdict.reasons.length >= 1);
  assert.equal(verdict.reasons[0].rule, 'R2');
});

test('v2 ranks a stricter band over an earlier one (v1 would have stopped at R1)', () => {
  const command = 'Remove-Item -Recurse C:\\Users\\Tester\\.dsh\\cache';
  const v1 = evaluate(policyV1(), shell(command), ENV);
  assert.equal(v1.rule, 'R1', 'v1 short-circuits on the first matching band');

  const v2 = evaluate(policyV2({ rules: { destructive: { mode: 'deny', patterns: [] } } }), shell(command), ENV);
  assert.equal(v2.mode, 'deny');
  assert.equal(v2.rule, 'R2', 'a deny outranks the R1 ask that matched first');
  assert.deepEqual(
    v2.reasons.map((reason) => reason.rule).sort(),
    ['R1', 'R2'],
    'both bands are recorded in reasons',
  );
});

test('v2 equal ranks keep band order: R1 before R2', () => {
  const verdict = evaluate(policyV2(), shell('Remove-Item -Recurse C:\\Users\\Tester\\.dsh\\cache'), ENV);
  assert.equal(verdict.mode, 'ask');
  assert.equal(verdict.rule, 'R1');
});

test('v2 entry deny beats the built-in R2 ask', () => {
  const policy = policyV2({
    entries: [{ id: 'no-dist-delete', tool: ['pwsh'], mode: 'deny', when: { commandMatches: '^\\s*Remove-Item\\b' } }],
  });
  const verdict = evaluate(policy, shell('Remove-Item -Recurse D:\\work\\dist'), ENV);
  assert.equal(verdict.mode, 'deny');
  assert.equal(verdict.rule, 'E');
  assert.equal(verdict.entryId, 'no-dist-delete');
});

test('v2 entry allow cannot override a built-in ask', () => {
  const policy = policyV2({
    entries: [{ id: 'allow-remove-in-proj', tool: ['pwsh'], mode: 'allow', when: { cwdUnder: ['D:\\work\\proj'] } }],
  });
  const verdict = evaluate(policy, shell('Remove-Item -Recurse D:\\work\\proj\\dist'), { ...ENV, CWD: 'D:\\work\\proj' });
  assert.equal(verdict.mode, 'ask');
  assert.equal(verdict.rule, 'R2');
});

test('v2 entry allow wins when nothing stricter matched', () => {
  const policy = policyV2({
    entries: [{ id: 'allow-build', tool: ['pwsh'], mode: 'allow', when: { commandMatches: '^\\s*npm run build\\b' } }],
  });
  const verdict = evaluate(policy, shell('npm run build'), ENV);
  assert.equal(verdict.mode, 'allow');
  assert.equal(verdict.rule, 'E');
  assert.equal(verdict.entryId, 'allow-build');
});

test('v2 entry conditions are a conjunction', () => {
  const policy = policyV2({
    entries: [{
      id: 'only-in-proj',
      tool: ['pwsh'],
      mode: 'deny',
      when: { cwdUnder: ['D:\\work\\proj'], commandMatches: '^\\s*Remove-Item\\b' },
    }],
  });
  assert.equal(evaluate(policy, shell('Remove-Item -Recurse D:\\work\\proj\\dist'), { ...ENV, CWD: 'D:\\work\\other' }).rule, 'R2');
  assert.equal(evaluate(policy, shell('Remove-Item -Recurse D:\\work\\proj\\dist'), { ...ENV, CWD: 'D:\\work\\proj' }).rule, 'E');
  // A missing CWD cannot satisfy cwdUnder.
  assert.equal(evaluate(policy, shell('Remove-Item -Recurse D:\\work\\proj\\dist'), ENV).rule, 'R2');
});

test('v2 cwdUnder compares path segments, not string prefixes', () => {
  const policy = policyV2({
    entries: [{ id: 'only-in-proj', tool: ['pwsh'], mode: 'deny', when: { cwdUnder: ['D:\\work\\proj'] } }],
  });
  assert.equal(evaluate(policy, shell('npm run build'), { ...ENV, CWD: 'D:\\work\\proj2' })?.rule, undefined, 'proj2 is not proj');
  assert.equal(evaluate(policy, shell('npm run build'), { ...ENV, CWD: 'D:\\work\\proj\\sub' }).rule, 'E');
});

test('v2 destructive observe records instead of asking', () => {
  const verdict = evaluate(policyV2({ rules: { destructive: { mode: 'observe', patterns: [] } } }), shell('Remove-Item -Recurse D:\\work\\dist'), ENV);
  assert.equal(verdict.mode, 'observe');
  assert.equal(verdict.observed, true);
  assert.equal(verdict.rule, 'R2');
});

test('v2 secrets observe keeps the secret off the card but still flags it', () => {
  const verdict = evaluate(
    policyV2({ rules: { secrets: { mode: 'observe', patterns: [] } } }),
    call('write', { file_path: 'D:\\work\\config.txt', content: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx' }),
    ENV,
  );
  assert.equal(verdict.mode, 'observe');
  assert.equal(verdict.secretHit, true);
  assert.equal(verdict.label, 'openai');
});

test('v2 secrets allow still cannot let a secret through a shell command', () => {
  const verdict = evaluate(
    policyV2({ rules: { secrets: { mode: 'allow', patterns: [] } } }),
    shell('Write-Output sk-proj-abcdefghijklmnopqrstuvwx'),
    ENV,
  );
  assert.equal(verdict.mode, 'deny', 'the shell clamp outranks the configured allow');
  assert.equal(verdict.secretHit, true);
});

test('v2 secretHit survives a stricter winner: the payload stays on the R3 track', () => {
  const verdict = evaluate(
    policyV2({
      rules: { secrets: { mode: 'observe', patterns: [] }, destructive: { mode: 'deny', patterns: [] } },
    }),
    shell('Remove-Item -Force D:\\work\\sk-proj-abcdefghijklmnopqrstuvwx.txt'),
    ENV,
  );
  assert.equal(verdict.mode, 'deny');
  assert.equal(verdict.rule, 'R2');
  assert.equal(verdict.secretHit, true, 'the audit must still treat this payload as a secret');
});

test('v2 returns null when nothing matched', () => {
  assert.equal(evaluate(policyV2(), shell('npm run build'), ENV), null);
});

test('v2 ignores entries for tools they do not list', () => {
  const policy = policyV2({
    entries: [{ id: 'bash-only', tool: ['bash'], mode: 'deny', when: { commandMatches: '^\\s*Remove-Item\\b' } }],
  });
  assert.equal(evaluate(policy, shell('Remove-Item -Recurse D:\\work\\dist'), ENV).rule, 'R2');
});

test('an E verdict is rendered in words, never as the rule id', () => {
  const policy = policyV2({
    entries: [{ id: 'no-dist-delete', tool: ['pwsh'], mode: 'deny', when: { commandMatches: '^\\s*Remove-Item\\b' } }],
  });
  const verdict = evaluate(policy, shell('Remove-Item -Recurse D:\\work\\dist'), ENV);
  const rendered = describe(verdict, { kind: 'delete', tool: 'pwsh', target: 'D:\\work\\dist', reversible: 'no', lines: 1 });
  assert.match(rendered.zh, /自定义规则 no-dist-delete 禁止此调用/);
  assert.match(rendered.en, /Custom rule no-dist-delete blocks this call/);
  assert.ok(!rendered.zh.includes('E'), 'the card must not show the bare rule id');
});

test('every action.entry.* key exists in both locale packs', () => {
  for (const mode of ['deny', 'ask', 'observe', 'allow']) {
    assert.equal(typeof LOCALES.zh[`action.entry.${mode}`], 'string', `zh action.entry.${mode}`);
    assert.equal(typeof LOCALES.en[`action.entry.${mode}`], 'string', `en action.entry.${mode}`);
  }
});

test('more than eight matches are cut, and the record says so', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    id: `watch-${index}`,
    tool: ['pwsh'],
    mode: 'observe',
    when: { commandMatches: '^\\s*Remove-Item\\b' },
  }));
  const verdict = evaluate(policyV2({ entries }), shell('Remove-Item -Recurse D:\\work\\dist'), ENV);
  assert.equal(verdict.rule, 'R2', 'the built-in ask outranks the observing entries');
  assert.equal(verdict.reasons.length, 8);
  assert.equal(verdict.reasonsTruncated, true);
});

test('eight or fewer matches are not flagged as truncated', () => {
  const verdict = evaluate(policyV2(), shell('Remove-Item -Recurse D:\\work\\dist'), ENV);
  assert.equal(verdict.reasonsTruncated, undefined);
});
