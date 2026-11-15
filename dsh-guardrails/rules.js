/**
 * Red-line evaluation. Pure: no file system access, no events, easy to unit test.
 * 红线判定。纯函数：不碰文件系统、不发事件，方便单测。
 *
 * Precedence, in order: R3 secrets -> R1 DSH's own home -> R2 critical -> R2 destructive.
 * 判定顺序：R3 密钥 -> R1 DSH 自身目录 -> R2c 系统级硬停 -> R2 破坏性操作。
 *
 *   R1 keeps DSH's own home untouched (~/.dsh, ~/.agents, its plugins and profile);
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

import { readOnlyDiagnostic } from './lib/critical.js';
import {
  DEFAULT_DESTRUCTIVE,
  DEFAULT_SECRETS,
  PATH_TOOLS,
  SHELL_TOOLS,
  criticalReason,
  expandPath,
  findCritical,
  isUnder,
  mentionsHomeNearWrite,
  pathOf,
  str,
} from './lib/rules/kit.js';
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
  const name = str(call?.name);
  const args = call?.arguments ?? call?.args ?? {};

  // ---- R3 secrets (most severe, evaluated first)
  const secret = evaluateR3(call, rules.secrets ?? {});
  if (secret !== null) return secret;

  // ---- R1 DSH's own home
  const homeRule = rules.protectDshHome ?? {};
  if (homeRule.mode !== 'off') {
    const roots = (homeRule.roots ?? ['~/.dsh', '~/.agents']).map((root) => expandPath(root, env)).filter(Boolean);
    const alwaysAsk = new Set(homeRule.alwaysAskTools ?? ['plugin_manager']);
    const mode = homeRule.mode === 'deny' ? 'deny' : 'ask';

    if (alwaysAsk.has(name)) {
      return {
        rule: 'R1',
        mode,
        reason: `Guardrails R1: tool "${name}" changes DSH's own profile/plugins under the protected home; it requires explicit approval.`,
      };
    }

    if (PATH_TOOLS.has(name)) {
      const target = expandPath(pathOf(args), env);
      if (isUnder(target, roots)) {
        return {
          rule: 'R1',
          mode,
          reason: `Guardrails R1: tool "${name}" writes inside DSH's protected home (${target}).`,
        };
      }
    }

    if (SHELL_TOOLS.has(name)) {
      const command = str(args.command ?? args.cmd ?? args.script);
      if (mentionsHomeNearWrite(command)) {
        return {
          rule: 'R1',
          mode,
          reason: `Guardrails R1: shell command both references DSH's protected home and writes/moves/deletes files.`,
        };
      }
    }
  }

  // ---- R2c critical hard stop (read-only diagnostics pass before destructive matching)
  const criticalRule = rules.critical ?? {};
  if (criticalRule.mode !== 'off' && SHELL_TOOLS.has(name)) {
    const command = str(args.command ?? args.cmd ?? args.script);
    const critical = findCritical(command, env, criticalRule.patterns ?? []);
    if (critical !== null) {
      const mode = criticalRule.mode === 'ask' ? 'ask' : 'deny';
      return {
        rule: 'R2',
        severity: 'critical',
        category: critical.category,
        mode,
        reason: criticalReason(critical, mode),
        ...(critical.target === '' ? {} : { target: critical.target }),
      };
    }

    // Read-only diagnostics stay usable; this must run before the R2 patterns,
    // otherwise `diskpart list disk` would be caught by the bare `diskpart` one.
    if (readOnlyDiagnostic(command)) return null;
  }

  // ---- R2 destructive operations
  const destructiveRule = rules.destructive ?? {};
  if (destructiveRule.mode !== 'off' && SHELL_TOOLS.has(name)) {
    const command = str(args.command ?? args.cmd ?? args.script);
    const patterns = [...DEFAULT_DESTRUCTIVE, ...(destructiveRule.patterns ?? [])];
    for (const source of patterns) {
      let re;
      try {
        re = new RegExp(source, 'i');
      } catch {
        continue;
      }
      const hit = re.exec(command);
      if (hit) {
        const shown = (hit[1] ?? hit[0]).trim();
        return {
          rule: 'R2',
          mode: destructiveRule.mode === 'deny' ? 'deny' : 'ask',
          reason: `Guardrails R2: destructive shell operation "${shown}" requires explicit approval.`,
        };
      }
    }
  }

  return null;
}
