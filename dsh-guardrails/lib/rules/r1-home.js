/**
 * R1: keep DSH's own home untouched.
 * R1：不碰 DSH 自身目录。
 *
 * Fires on three shapes: a tool whose arguments name a path inside the protected
 * home; a shell command that mentions the home and writes next to it; and any
 * tool listed in alwaysAskTools (default: plugin_manager).
 */

import {
  PATH_TOOLS,
  SHELL_TOOLS,
  expandPath,
  isUnder,
  mentionsHomeNearWrite,
  pathOf,
  str,
} from './kit.js';

/**
 * @param {{name: string, arguments?: object, args?: object}} call
 * @param {object} rule the policy slice rules.protectDshHome
 * @param {object} env shape: { USERPROFILE, DSH_HOME, AGENTS_HOME }
 * @param {{v2?: boolean}} [opts] engine v2 reports the configured mode as-is
 * @returns {null | {rule: 'R1', mode: string, reason: string}}
 */
export function evaluateR1(call, rule = {}, env, opts = {}) {
  if (rule.mode === 'off') return null;
  const name = str(call?.name);
  const args = call?.arguments ?? call?.args ?? {};
  const roots = (rule.roots ?? ['~/.dsh', '~/.agents']).map((root) => expandPath(root, env)).filter(Boolean);
  const alwaysAsk = new Set(rule.alwaysAskTools ?? ['plugin_manager']);
  const mode = opts.v2 === true ? (rule.mode ?? 'ask') : (rule.mode === 'deny' ? 'deny' : 'ask');

  if (alwaysAsk.has(name)) {
    return {
      rule: 'R1',
      mode,
      reason: `Guardrails R1: tool "${name}" changes DSH's own profile/plugins under the protected home; it requires explicit approval.`,
    };
  }

  if (PATH_TOOLS.has(name)) {
    const target = expandPath(pathOf(args), env, env?.CWD);
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

  return null;
}
