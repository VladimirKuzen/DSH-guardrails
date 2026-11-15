/**
 * R2: destructive shell operations, including the critical tier.
 * R2：破坏性 shell 操作，含 critical 层。
 *
 * Order inside this rule is load-bearing: the critical matcher runs first, then
 * read-only diagnostics pass, and only then the destructive pattern list is
 * tried. Without that order `diskpart list disk` would be caught by the bare
 * `diskpart` pattern and a full format command would be asked instead of refused.
 */

import { readOnlyDiagnostic } from '../critical.js';
import { DEFAULT_DESTRUCTIVE, SHELL_TOOLS, criticalReason, findCritical, str } from './kit.js';

/**
 * @param {{name: string, arguments?: object, args?: object}} call
 * @param {object} rules the policy slice rules (reads rules.critical and rules.destructive)
 * @param {object} env shape: { USERPROFILE, DSH_HOME, AGENTS_HOME, SystemRoot, ProgramFiles, ... }
 * @returns {null | {rule: 'R2', mode: string, severity?: 'critical', category?: string, reason: string, target?: string}}
 */
export function evaluateR2(call, rules = {}, env) {
  const name = str(call?.name);
  const args = call?.arguments ?? call?.args ?? {};

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
