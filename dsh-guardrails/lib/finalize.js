/**
 * The one place where "an ordinary destructive ask becomes a quiet allow" lives.
 *
 * The host (`index.js`), the contract runner (`test/contract.test.mjs`) and the
 * `check` CLI (`tools/check.mjs`) all call this. Keeping it here is what makes
 * the three agree: before, each caller reproduced the same `if` chain by hand,
 * and a change in one of them was invisible to the others.
 */

import { RANK } from '../rules.js';
import { decideQuiet } from './rules/quiet.js';
import { selfRoots } from './rules/r1-self.js';

/**
 * Paths that feed `facts.protectedHit` and the card copy: the DSH home roots
 * plus the gate's own source directory (and any extra `selfProtect.paths`).
 */
export function factRoots(policy, env) {
  const homeRoots = policy?.rules?.protectDshHome?.roots ?? ['~/.dsh', '~/.agents'];
  return [...new Set([...homeRoots, ...selfRoots(policy?.rules?.selfProtect ?? {}, env)])];
}

/**
 * Decide whether `verdict` should be downgraded to a quiet allow.
 *
 * Only an ordinary R2 ask qualifies. Under engine v2 the winner can be R2 while
 * another band also matched, so every reason that is at least as strict as ask
 * must be an ordinary R2 and the call must not contain a secret anywhere.
 *
 * Weaker matches do not veto quiet: an `observe` entry that happens to cover the
 * same call is a request to watch it, not a request to card it. Letting observe
 * veto quiet made the two features cancel each other — turning on a watcher
 * silently turned off workspace quiet for everything it matched.
 */
export function applyWorkspaceQuiet({ policy, call, verdict, facts, cwd }) {
  if (verdict === null || verdict === undefined) return { verdict, decision: null };

  const blocksQuiet = (reason) => {
    const rank = RANK[reason?.mode] ?? 0;
    if (rank > RANK.ask) return true; // deny/block
    if (rank < RANK.ask) return false; // observe/allow: a watcher, not a veto
    return reason.rule !== 'R2' || reason.severity !== undefined;
  };
  if (verdict.mode !== 'ask' || verdict.rule !== 'R2' || verdict.severity !== undefined
    || (verdict.reasons ?? []).some(blocksQuiet) || verdict.secretHit === true) {
    return { verdict, decision: null };
  }

  const decision = decideQuiet({
    tool: call?.name,
    command: call?.arguments?.command,
    facts,
    config: policy?.rules?.quiet,
    cwd,
  });
  if (!decision.quiet) return { verdict, decision };

  return { verdict: { ...verdict, mode: 'allow', quiet: 'workspace' }, decision };
}
