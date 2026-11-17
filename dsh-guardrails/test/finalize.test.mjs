/**
 * The finalize step: which verdicts workspace quiet is allowed to soften, and
 * where its configuration is read from.
 *
 * These are unit tests of the gate itself; `test/contract.test.mjs` proves the
 * same gate is what the host, the CLI and the table all run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { applyAliases } from '../lib/policy/merge.js';
import { applyWorkspaceQuiet } from '../lib/finalize.js';

const QUIET = { enabled: true, roots: ['D:\\work\\proj'], paths: ['_scratch'], alwaysAsk: ['.git'] };
const policy = (rules = {}) => ({ rules: { quiet: QUIET, ...rules } });
const call = { name: 'pwsh', arguments: { command: "Remove-Item 'D:\\work\\proj\\_scratch\\a.txt' -Force" } };
const facts = { kind: 'delete', target: 'D:\\work\\proj\\_scratch\\a.txt', count: 1 };
const ask = (extra = {}) => ({ rule: 'R2', mode: 'ask', ...extra });

const run = (verdict, options = {}) => applyWorkspaceQuiet({
  policy: policy(),
  call,
  verdict,
  facts,
  cwd: 'D:\\work\\proj',
  ...options,
});

test('aliases: rules.destructive.workspaceQuiet moves to rules.quiet', () => {
  const moved = applyAliases({
    rules: { destructive: { mode: 'ask', workspaceQuiet: QUIET } },
  });
  assert.deepEqual(moved.rules.quiet, QUIET);
  assert.deepEqual(moved.rules.destructive, { mode: 'ask' });
});

test('aliases: an explicit rules.quiet is not overwritten by the legacy key', () => {
  const explicit = { enabled: false };
  const moved = applyAliases({
    rules: { quiet: explicit, destructive: { mode: 'ask', workspaceQuiet: QUIET } },
  });
  assert.deepEqual(moved.rules.quiet, explicit);
});

test('aliases: a policy without either location is returned unchanged', () => {
  const original = { rules: { destructive: { mode: 'ask' } } };
  const out = applyAliases(original);
  assert.equal(out.rules.quiet, undefined);
  assert.deepEqual(out.rules.destructive, { mode: 'ask' });
});

test('quiet: an ordinary R2 ask about a single temp file becomes an allow', () => {
  const { verdict, decision } = run(ask());
  assert.equal(verdict.mode, 'allow');
  assert.equal(verdict.quiet, 'workspace');
  assert.equal(decision.quiet, true);
});

test('quiet: an observe reason does not veto it', () => {
  // Regression: the gate used to require every reason to be a plain R2, so any
  // matching observe entry silently turned quiet off for everything it covered.
  const { verdict } = run(ask({ reasons: [{ rule: 'E', mode: 'observe', entryId: 'watch-scratch' }] }));
  assert.equal(verdict.mode, 'allow');
  assert.equal(verdict.quiet, 'workspace');
});

test('quiet: a stricter reason still vetoes it', () => {
  for (const reason of [
    { rule: 'R1', mode: 'ask' },
    { rule: 'R2', mode: 'deny' },
    { rule: 'R2', mode: 'ask', severity: 'critical' },
  ]) {
    const { verdict } = run(ask({ reasons: [{ rule: 'R2', mode: 'ask' }, reason] }));
    assert.equal(verdict.mode, 'ask', `${reason.rule}/${reason.mode} must keep the card`);
    assert.equal(verdict.quiet, undefined);
  }
});

test('quiet: a secret anywhere in the call vetoes it', () => {
  const { verdict } = run(ask({ secretHit: true, reasons: [{ rule: 'R3', mode: 'observe' }] }));
  assert.equal(verdict.mode, 'ask');
});

test('quiet: only an ask about the destructive band qualifies', () => {
  for (const verdict of [
    null,
    { rule: 'R1', mode: 'ask' },
    { rule: 'R2', mode: 'deny' },
    { rule: 'R2', mode: 'observe' },
    { rule: 'R2', mode: 'ask', severity: 'critical' },
    { rule: 'E', mode: 'ask', entryId: 'a1' },
  ]) {
    const out = run(verdict);
    if (verdict === null) {
      assert.equal(out.verdict, null);
      assert.equal(out.decision, null);
    } else {
      assert.equal(out.verdict.mode, verdict.mode, `${verdict.rule}/${verdict.mode} must not be softened`);
      assert.equal(out.verdict.quiet, undefined);
    }
  }
});

test('quiet: config is read from rules.quiet, not from the old location', () => {
  const legacyOnly = { rules: { destructive: { mode: 'ask', workspaceQuiet: QUIET } } };
  const { verdict, decision } = run(ask(), { policy: legacyOnly });
  assert.equal(verdict.mode, 'ask');
  assert.equal(decision.reason, 'disabled');
});
