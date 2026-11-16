/**
 * Entries: user-declared rules that sit beside the built-in bands.
 * 条目：用户声明的规则，与内置的几条带并列参与同一次判定。
 *
 * An entry never replaces a built-in rule: every band runs and the strictest
 * verdict wins (see rules.js). That is why an "allow" entry cannot punch a hole
 * in R1/R2/R3 -- it only wins when nothing stricter matched, and the audit still
 * records that it fired.
 * 条目从不取代内置规则：每条带都跑，最严的赢（见 rules.js）。所以 "allow" 条目
 * 打不穿 R1/R2/R3 —— 只有没人更严时才生效，而且审计里仍然留痕。
 *
 * `when` is a conjunction: every present condition must hold. A missing `when`
 * matches every call of the listed tools (policy validation forces an "allow"
 * entry to narrow, so a bare allow cannot be written by accident).
 * `when` 是合取：写了几个条件就必须同时满足。不写 `when` 表示该工具的全部调用
 * 都命中（校验器会逼 "allow" 条目必须收窄，避免手滑写出裸 allow）。
 */

import { SHELL_TOOLS, expandPath, isUnder, pathOf, str } from './kit.js';

const REASONS = {
  deny: (id) => `Guardrails E: entry "${id}" forbids this call.`,
  ask: (id) => `Guardrails E: entry "${id}" requires approval for this call.`,
  observe: (id) => `Guardrails E: entry "${id}" matched; this call is recorded, not stopped.`,
  allow: (id) => `Guardrails E: entry "${id}" allows this call.`,
};

function rootsOf(list, env) {
  if (!Array.isArray(list)) return [];
  return list.map((root) => expandPath(root, env, env?.CWD)).filter((root) => root !== '');
}

/**
 * @param {{name: string, arguments?: object, args?: object}} call
 * @param {Array<object>} entries the policy `entries` array
 * @param {object} env shape: { CWD, USERPROFILE, ... }
 * @returns {Array<{rule: 'E', entryId: string, mode: string, reason: string}>} one hit per matching entry
 */
export function evaluateEntries(call, entries, env) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const name = str(call?.name);
  const args = call?.arguments ?? call?.args ?? {};
  const command = SHELL_TOOLS.has(name) ? str(args.command ?? args.cmd ?? args.script) : '';
  // Normalize like every other path comparison: lowercase, backslashes.
  const cwd = expandPath(str(env?.CWD), env);
  const target = expandPath(pathOf(args), env, env?.CWD);

  const hits = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.mode === 'off' || entry.mode === undefined) continue;
    if (!Array.isArray(entry.tool) || !entry.tool.includes(name)) continue;

    const when = entry.when ?? {};
    if (when.cwdUnder !== undefined && !(cwd !== '' && isUnder(cwd, rootsOf(when.cwdUnder, env)))) continue;
    // A shell command rarely names a single resolvable target, so targetUnder
    // stays silent for it rather than pretending to know.
    if (when.targetUnder !== undefined && !(target !== '' && isUnder(target, rootsOf(when.targetUnder, env)))) continue;
    if (when.commandMatches !== undefined) {
      if (command === '') continue;
      let re;
      try {
        re = new RegExp(when.commandMatches);
      } catch {
        continue;
      }
      if (!re.test(command)) continue;
    }

    const reason = REASONS[entry.mode];
    if (reason === undefined) continue;
    hits.push({ rule: 'E', entryId: entry.id, mode: entry.mode, reason: reason(entry.id) });
  }
  return hits;
}
