/**
 * Contract table runner: one JSON table, asserted against the real verdict.
 *
 * The table is meant to be the single place where "what the gate decides" is
 * written down, so that the CLI (`tools/check.mjs`) can be tested against the
 * same expectations later without a second description of the rules.
 *
 * Decision words used here are the exit-code boundary ones:
 *   allow -> 0, review -> 2, block -> 3.
 *
 * Two case kinds need a caveat, and both are asserted honestly:
 *   - `knownGap: true` cases assert that the current build still lets the call
 *     through. When one is fixed, flip the expectation; do not leave a red test.
 *   - `v2Only: true` cases describe engine v2 behaviour (entries, observe, allow)
 *     and only run with `"version": 2` in their policy.
 *   `v2Only` cases describe engine v2 behaviour (entries, observe, allow); they
 *   carry their own `"version": 2` policy and run like any other case.
 *
 * Workspace quiet lives in `index.js` rather than in `evaluate()`. The runner
 * mirrors that wiring with the same two helpers (`collectFacts`, `decideQuiet`
 * in the same order); when P3 extracts the finalize step, this block can call it
 * instead of reproducing the order.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { evaluate } from '../rules.js';
import { collectFacts } from '../lib/facts.js';
import { decideQuiet } from '../lib/rules/quiet.js';

const CASES = JSON.parse(
  readFileSync(new URL('./fixtures/contract-cases.json', import.meta.url), 'utf8'),
);

/** Mirror of the runtime environment `envForRules()` hands to `evaluate()`. */
const BASE_ENV = {
  USERPROFILE: 'C:\\Users\\Tester',
  HOME: 'C:\\Users\\Tester',
  DSH_HOME: 'C:\\Users\\Tester\\.dsh',
  AGENTS_HOME: 'C:\\Users\\Tester\\.agents',
};

/** Mirror of the `DEFAULTS` in `index.js` (rules block, self-protection included). */
const DEFAULT_POLICY = {
  enabled: true,
  rules: {
    protectDshHome: { mode: 'ask', roots: ['~/.dsh', '~/.agents'], alwaysAskTools: ['plugin_manager'] },
    critical: { mode: 'deny', patterns: [], failClosed: true },
    destructive: { mode: 'ask', patterns: [] },
    secrets: { mode: 'ask', patterns: [] },
    selfProtect: { mode: 'ask', paths: [] },
  },
};

const EXIT_BY_DECISION = { allow: 0, review: 2, block: 3 };

/** Map a verdict to the boundary decision word. */
function decisionOf(verdict) {
  if (verdict === null || verdict === undefined) return 'allow';
  if (verdict.mode === 'ask') return 'review';
  if (verdict.mode === 'deny') return 'block';
  return 'allow';
}

/** Run one case exactly the way the host runs a tool call, minus audit and events. */
function decide(tc) {
  const policy = tc.policy ?? DEFAULT_POLICY;
  const call = { name: tc.tool, arguments: tc.args };
  // `cwd` is what index.js passes as env.CWD; entries and relative paths need it.
  const env = { ...BASE_ENV, ...(tc.cwd === undefined ? {} : { CWD: tc.cwd }), ...(tc.env ?? {}) };

  let verdict = evaluate(policy, call, env);

  // Same gate as index.js: only an ordinary R2 ask can be quieted, and under v2
  // every reason must be an ordinary R2 with no secret in the call.
  const onlyOrdinaryR2 = verdict?.reasons === undefined
    || verdict.reasons.every((reason) => reason.rule === 'R2' && reason.severity === undefined);
  if (verdict !== null && verdict.mode === 'ask' && verdict.rule === 'R2' && verdict.severity === undefined
    && onlyOrdinaryR2 && verdict.secretHit !== true) {
    const roots = policy.rules?.protectDshHome?.roots ?? ['~/.dsh', '~/.agents'];
    // Quiet needs the target to exist as a single file; `io` stubs that stat so
    // the table does not depend on files on the machine that runs it.
    const io = tc.io === undefined
      ? undefined
      : {
          statSync: () => ({ isDirectory: () => tc.io.type === 'dir' }),
          readdirSync: () => ['a', 'b'],
        };
    const facts = collectFacts(call, verdict, env, io === undefined ? { roots } : { roots, io });
    const quiet = decideQuiet({
      tool: tc.tool,
      command: tc.args?.command,
      facts,
      config: policy.rules?.destructive?.workspaceQuiet,
      cwd: tc.cwd ?? null,
    });
    if (quiet.quiet) verdict = { ...verdict, mode: 'allow', quiet: 'workspace' };
  }

  return verdict;
}

function describeVerdict(verdict) {
  if (verdict === null || verdict === undefined) return 'allow (no verdict)';
  const parts = [verdict.mode, verdict.rule];
  if (verdict.severity !== undefined) parts.push(verdict.severity);
  if (verdict.label !== undefined) parts.push(`label=${verdict.label}`);
  return parts.join(' ');
}

test('contract table: every case is well formed', () => {
  const seen = new Set();
  for (const tc of CASES) {
    assert.equal(typeof tc.id, 'string', 'case needs a string id');
    assert.ok(!seen.has(tc.id), `duplicate case id: ${tc.id}`);
    seen.add(tc.id);

    assert.equal(typeof tc.tool, 'string', `${tc.id}: tool must be a string`);
    assert.equal(typeof tc.args, 'object', `${tc.id}: args must be an object`);
    assert.ok(tc.expect && typeof tc.expect === 'object', `${tc.id}: expect is required`);

    const decision = tc.expect.decision;
    assert.ok(decision in EXIT_BY_DECISION, `${tc.id}: unknown decision "${decision}"`);
    assert.equal(
      tc.expect.exitCode,
      EXIT_BY_DECISION[decision],
      `${tc.id}: exitCode must match decision (${decision} -> ${EXIT_BY_DECISION[decision]})`,
    );
    if (decision !== 'allow') {
      assert.equal(typeof tc.expect.rule, 'string', `${tc.id}: a gated case needs a rule id`);
    }
    assert.ok(!(tc.knownGap && tc.v2Only), `${tc.id}: a case cannot be both knownGap and v2Only`);
    if (tc.expect.mode !== undefined) {
      // `observe` is a boundary allow; the mode assertion is what keeps it from
      // silently becoming a plain allow (which would erase the audit record).
      assert.equal(decision, 'allow', `${tc.id}: only an allow can carry expect.mode`);
      assert.equal(tc.expect.mode, 'observe', `${tc.id}: the only mode worth asserting is observe`);
    }
  }
});

for (const tc of CASES) {
  const name = tc.knownGap
    ? `contract (known gap): ${tc.id}`
    : tc.v2Only
      ? `contract (v2): ${tc.id}`
      : `contract: ${tc.id}`;

  test(name, () => {
    const verdict = decide(tc);
    const decision = decisionOf(verdict);

    assert.equal(
      decision,
      tc.expect.decision,
      `${tc.id}: expected ${tc.expect.decision}, got ${describeVerdict(verdict)}` +
        (verdict?.reason ? ` (reason: ${verdict.reason})` : ''),
    );

    if (tc.expect.rule !== undefined) {
      assert.equal(verdict?.rule, tc.expect.rule, `${tc.id}: expected rule ${tc.expect.rule}, got ${verdict?.rule}`);
    }
    if (tc.expect.severity !== undefined) {
      assert.equal(
        verdict?.severity,
        tc.expect.severity,
        `${tc.id}: expected severity ${tc.expect.severity}, got ${verdict?.severity}`,
      );
    }
    if (tc.expect.mode !== undefined) {
      assert.equal(verdict?.mode, tc.expect.mode, `${tc.id}: expected winner mode ${tc.expect.mode}, got ${verdict?.mode}`);
    }
    if (tc.expect.quiet !== undefined) {
      assert.equal(verdict?.quiet, tc.expect.quiet, `${tc.id}: expected quiet ${tc.expect.quiet}`);
    }
  });
}
