/**
 * Red-line evaluation. Pure: no file system access, no events, easy to unit test.
 * 红线判定。纯函数：不碰文件系统、不发事件，方便单测。
 *
 * Precedence, in order: R3 secrets -> R1 DSH's own home -> R1 the gate's own
 * source -> R2 critical -> R2 destructive -> user entries.
 * 判定顺序：R3 密钥 -> R1 DSH 自身目录 -> R1 护栏自身源码 -> R2c 系统级硬停 ->
 * R2 破坏性操作 -> 用户条目。
 *
 *   R1 keeps DSH's own home untouched (~/.dsh, ~/.agents, its plugins and profile)
 *      and keeps the gate's own source from being edited through the gate itself;
 *   R2 asks before destructive shell operations, and refuses the critical tier;
 *   R3 keeps secrets in config files, never in the conversation.
 *
 * Two engines, one entry point:
 *   version 1 (or no version) short-circuits band by band, exactly as it always
 *   has, so an upgrade never changes a verdict;
 *   version 2 collects every band that matched, ranks them and returns the
 *   strictest, so a new entry can never silently outrank a red line.
 * 两个引擎共用一个入口：v1（缺省）逐带短路，返回值与旧版一致；v2 收集所有命中、
 * 按严重度排序后取最严的一条，条目无法越过红线。
 *
 * Shared helpers and the default pattern tables live in lib/rules/kit.js.
 * 共享工具与默认模式表在 lib/rules/kit.js。
 *
 * Returns null to allow the call (nothing matched); otherwise returns
 * { rule, mode, reason, label? }. Critical Windows operations add
 * { severity: "critical", category, target }. Engine v2 adds
 * { reasons, secretHit, policyVersion: 2, observed? }.
 * Presentation copy (displayReason) is built by the host in index.js.
 */

import {
  DEFAULT_DESTRUCTIVE,
  DEFAULT_SECRETS,
  SHELL_TOOLS,
  criticalReason,
  expandPath,
  findCritical,
  str,
} from './lib/rules/kit.js';
import { evaluateEntries } from './lib/rules/entries.js';
import { evaluateR1 } from './lib/rules/r1-home.js';
import { evaluateR1Self } from './lib/rules/r1-self.js';
import { evaluateR2, evaluateR2Parts } from './lib/rules/r2-destructive.js';
import { evaluateR3 } from './lib/rules/r3-secrets.js';

// Kept as part of this module's public surface: tests and policy examples import them.
export { DEFAULT_DESTRUCTIVE, DEFAULT_SECRETS, expandPath };

/** Strictness ordering used by engine v2. Equal ranks keep band order. */
export const RANK = Object.freeze({ deny: 3, ask: 2, observe: 1, allow: 0 });

/** A card only ever shows the winner; the audit keeps the rest, bounded. */
const MAX_REASONS = 8;

/**
 * Fail-closed path for the critical tier: when rule evaluation throws, refuse a
 * shell call that still matches the critical matcher instead of letting it run.
 * Returns a deny verdict, or null to fall through to the normal fail-open path.
 */
export function criticalFallback(policy, call, env = {}) {
  const criticalRule = policy?.rules?.critical ?? {};
  if (criticalRule.mode === 'off' || criticalRule.failClosed === false) return null;
  if (!SHELL_TOOLS.has(str(call?.name))) return null;
  const args = call?.arguments ?? {};
  const command = str(args.command ?? args.cmd ?? args.script);
  const critical = findCritical(command, env, criticalRule.patterns ?? []);
  if (critical === null) return null;
  return {
    rule: 'R2',
    severity: 'critical',
    category: critical.category,
    mode: 'deny',
    reason: `${criticalReason(critical, 'deny')} Rule evaluation failed, so the call was refused without a card.`,
  };
}

/**
 * Decide one tool call.
 * @param {object} policy parsed policy
 * @param {{name: string, args: unknown}} call the tool call
 * @param {object} env shape: { USERPROFILE, DSH_HOME, AGENTS_HOME, CWD }
 * @returns {null | {rule: string, mode: string, reason: string, label?: string}}
 */
export function evaluate(policy, call, env) {
  if (policy === null || typeof policy !== 'object' || policy.enabled === false) return null;
  const rules = policy.rules ?? {};
  return policy.version === 2
    ? evaluateV2(policy, call, env, rules)
    : evaluateV1(call, env, rules);
}

/** Engine v1: the historic band-by-band short circuit. Output is unchanged. */
function evaluateV1(call, env, rules) {
  // ---- R3 secrets (most severe, evaluated first)
  const secret = evaluateR3(call, rules.secrets ?? {});
  if (secret !== null) return secret;

  // ---- R1 DSH's own home, then the gate's own source (same band, home first)
  const home = evaluateR1(call, rules.protectDshHome ?? {}, env);
  if (home !== null) return home;

  const self = evaluateR1Self(call, rules.selfProtect ?? {}, env);
  if (self !== null) return self;

  // ---- R2 critical tier, read-only diagnostics, then destructive operations
  return evaluateR2(call, rules, env);
}

/** Engine v2: collect, rank, keep the strictest. Ties keep band order. */
function evaluateV2(policy, call, env, rules) {
  const opts = { v2: true };
  const candidates = [];
  const add = (verdict) => {
    if (verdict === null || typeof verdict !== 'object') return;
    if (RANK[verdict.mode] === undefined) return;
    candidates.push(verdict);
  };

  // Band order is the tie-breaker: R3 -> R1home -> R1self -> R2c -> R2d -> entries.
  add(evaluateR3(call, rules.secrets ?? {}, opts));
  add(evaluateR1(call, rules.protectDshHome ?? {}, env, opts));
  add(evaluateR1Self(call, rules.selfProtect ?? {}, env, opts));
  const parts = evaluateR2Parts(call, rules, env, opts);
  add(parts.critical);
  add(parts.destructive);
  for (const hit of evaluateEntries(call, policy.entries, env)) add(hit);

  if (candidates.length === 0) return null;

  // A secret anywhere in the call keeps the audit on the R3 track, even when a
  // stricter band wins the card: otherwise the secret text could be persisted.
  const secretHit = candidates.some((candidate) => candidate.rule === 'R3');

  let winner = candidates[0];
  for (const candidate of candidates) {
    if (RANK[candidate.mode] > RANK[winner.mode]) winner = candidate;
  }

  const reasons = candidates.slice(0, MAX_REASONS).map(({ rule, sub, mode, severity, entryId }) => ({
    rule,
    mode,
    ...(sub === undefined ? {} : { sub }),
    ...(severity === undefined ? {} : { severity }),
    ...(entryId === undefined ? {} : { entryId }),
  }));

  return {
    ...winner,
    reasons,
    secretHit,
    policyVersion: 2,
    ...(winner.mode === 'observe' ? { observed: true } : {}),
  };
}
