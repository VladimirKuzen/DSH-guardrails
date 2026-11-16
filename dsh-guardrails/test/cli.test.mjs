/**
 * Contract runner #2: the `check` CLI must answer exactly what the runtime
 * answers, and must express it as an exit code.
 *
 * The table is shared with `test/contract.test.mjs` on purpose: two runners over
 * one table is what makes "the CLI and the host agree" a test instead of a hope.
 * Exit-code mapping is part of the contract (0 allow, 2 review, 3 block, 1
 * error), so a drift in either direction fails here.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { run } from '../tools/check.mjs';
import { DEFAULTS } from '../index.js';

const cases = JSON.parse(
  readFileSync(new URL('./fixtures/contract-cases.json', import.meta.url), 'utf8'),
);

const dir = mkdtempSync(join(tmpdir(), 'guardrails-cli-'));
const POLICY_WITH_DEFAULTS = join(dir, 'defaults.json');
writeFileSync(POLICY_WITH_DEFAULTS, JSON.stringify({ version: 1, ...DEFAULTS }, null, 2), 'utf8');

// The table addresses a fake user home; replay it against that home instead of
// the machine's real one, exactly like the runtime contract runner does.
const BASE_ENV = {
  USERPROFILE: 'C:\\Users\\Tester',
  HOME: 'C:\\Users\\Tester',
  DSH_HOME: 'C:\\Users\\Tester\\.dsh',
  AGENTS_HOME: 'C:\\Users\\Tester\\.agents',
};

/** Run the CLI in-process and return its exit code plus parsed --json output. */
function check(argv, input = '') {
  const out = [];
  const err = [];
  const withJson = argv.includes('--json') ? argv : [...argv, '--json'];
  const code = run(withJson, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    stdin: () => input,
    env: BASE_ENV,
  });
  const text = out.join('\n');
  const trimmed = text.trim();
  return { code, json: trimmed.startsWith('{') ? JSON.parse(trimmed) : null, stdout: trimmed, stderr: err.join('\n') };
}

/** Write a per-case policy file (cases with their own policy get their own file). */
function policyFor(tc) {
  if (tc.policy === undefined) return POLICY_WITH_DEFAULTS;
  const path = join(dir, `${tc.id}.json`);
  writeFileSync(path, JSON.stringify(tc.policy, null, 2), 'utf8');
  return path;
}

const CASES = cases.filter((tc) => tc.io === undefined);

test('the CLI table covers every case the runtime table covers', () => {
  const skipped = cases.filter((tc) => tc.io !== undefined).map((tc) => tc.id);
  assert.deepEqual(skipped, ['quiet-enabled-eligible'],
    'only the case with a fabricated file can be skipped, and only because this runner has no stat stub');
  assert.ok(CASES.length >= 60);
});

for (const tc of CASES) {
  test(`cli: ${tc.id}`, () => {
    const argv = ['--tool', tc.tool, '--args', JSON.stringify(tc.args), '--policy', policyFor(tc)];
    if (tc.cwd !== undefined) argv.push('--cwd', tc.cwd);
    const { code, json } = check(argv);
    assert.equal(json?.decision, tc.expect.decision, `${tc.id}: decision`);
    if (tc.expect.mode !== undefined) {
      assert.equal(json?.winner?.mode, tc.expect.mode, `${tc.id}: winner mode`);
    }
    assert.equal(code, tc.expect.exitCode, `${tc.id}: exit code`);
  });
}

test('cli: exit 0 only ever means "allowed"', () => {
  const { code, json } = check(
    ['--tool', 'pwsh', '--args', JSON.stringify({ command: 'git status' }), '--policy', POLICY_WITH_DEFAULTS],
  );
  assert.equal(code, 0);
  assert.equal(json.decision, 'allow');
});

test('cli: a bad argument is exit 1, not exit 0', () => {
  const { code, json } = check(['--tool', 'pwsh', '--args', '{not json', '--policy', POLICY_WITH_DEFAULTS]);
  assert.equal(code, 1);
  assert.equal(json, null);
});

test('cli: an unknown flag is exit 1', () => {
  const { code } = check(['--tool', 'pwsh', '--args', '{}', '--nope']);
  assert.equal(code, 1);
});

test('cli: a missing --tool is exit 1', () => {
  const { code } = check(['--args', '{}', '--policy', POLICY_WITH_DEFAULTS]);
  assert.equal(code, 1);
});

test('cli: --validate accepts the shipped defaults and rejects a broken file', () => {
  const ok = check(['--validate', '--policy', POLICY_WITH_DEFAULTS]);
  assert.equal(ok.code, 0);

  const broken = join(dir, 'broken.json');
  writeFileSync(broken, JSON.stringify({ version: 1, rules: { secrets: { mode: 'allow' } } }), 'utf8');
  const bad = check(['--validate', '--policy', broken]);
  assert.equal(bad.code, 1, 'an invalid policy must never report success');
});

test('cli: a policy that fails validation is refused, not silently defaulted', () => {
  const broken = join(dir, 'broken2.json');
  writeFileSync(broken, JSON.stringify({ version: 1, rules: { protectDshHom: { mode: 'off' } } }), 'utf8');
  const { code, json } = check(
    ['--tool', 'write', '--args', JSON.stringify({ file_path: 'C:\\x.txt' }), '--policy', broken],
  );
  assert.equal(code, 1);
  assert.equal(json, null);
});

test('cli: --args - reads the arguments from stdin', () => {
  const { code, json } = check(
    ['--tool', 'pwsh', '--args', '-', '--policy', POLICY_WITH_DEFAULTS, '--json'],
    JSON.stringify({ command: 'git status' }),
  );
  assert.equal(code, 0);
  assert.equal(json.decision, 'allow');
});

test('cli: a missing policy file falls back to the built-in defaults', () => {
  const { code, stderr } = check(
    ['--tool', 'write', '--args', JSON.stringify({ file_path: 'C:\\Users\\Tester\\.dsh\\x' }), '--policy', join(dir, 'nope.json')],
  );
  assert.equal(code, 2, 'defaults still protect the DSH home');
  assert.match(stderr, /no policy file/);
});

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});
