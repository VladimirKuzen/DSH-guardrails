/**
 * Red-line evaluation. Pure: no file system access, no events, easy to unit test.
 * 红线判定。纯函数：不碰文件系统、不发事件，方便单测。
 *
 * Precedence, in order: R3 secrets -> R1 DSH's own home -> R1 the gate's own
 * source -> R2 critical -> R2 destructive.
 * 判定顺序：R3 密钥 -> R1 DSH 自身目录 -> R1 护栏自身源码 -> R2c 系统级硬停 -> R2 破坏性操作。
 *
 *   R1 keeps DSH's own home untouched (~/.dsh, ~/.agents, its plugins and profile)
 *      and keeps the gate's own source from being edited through the gate itself;
 *   R2 asks before destructive shell operations, and refuses the critical tier;
 *   R3 keeps secrets in config files, never in the conversation.
 *
 * Shared helpers and the default pattern tables live in lib/rules/kit.js.
 * 共享工具与默认模式表在 lib/rules/kit.js。
 *
 * Returns null to allow the call; otherwise returns { rule, mode, reason, label }.
 * Critical Windows operations add { severity: "critical", category, target }.
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
import { evaluateR1 } from './lib/rules/r1-home.js';
import { evaluateR1Self } from './lib/rules/r1-self.js';
import { evaluateR2 } from './lib/rules/r2-destructive.js';
import { evaluateR3 } from './lib/rules/r3-secrets.js';

// Kept as part of this module's public surface: tests and policy examples import them.
export { DEFAULT_DESTRUCTIVE, DEFAULT_SECRETS, expandPath };

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
 * @param {object} env shape: { USERPROFILE, DSH_HOME, AGENTS_HOME }
 * @returns {null | {rule: string, mode: string, reason: string, label?: string}}
 */
export function evaluate(policy, call, env) {
  if (policy === null || typeof policy !== 'object' || policy.enabled === false) return null;
  const rules = policy.rules ?? {};

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
