/**
 * R3: secrets in tool arguments.
 * R3：工具参数里的密钥。
 *
 * Shell commands are refused outright: the host echoes a command verbatim in its
 * approval card, so asking about one would display the secret. A file write has
 * no such echo and may still be approved, with the label only.
 *
 * Engine v2 lets the policy pick "observe" (record only) or "allow", but the shell
 * clamp stays: a card would echo the command, so a shell hit is denied unless the
 * policy asked to only observe it. 引擎 v2 允许配置 observe / allow，但 shell 的
 * 钳制仍在：卡片会回显命令，所以 shell 命中除了 observe 一律拒绝。
 */

import { DEFAULT_SECRETS, SHELL_TOOLS, allStrings, labelFor, str } from './kit.js';

/** v2: the configured mode, with the shell clamp that keeps secrets off the card. */
function modeForV2(configured, inShellCommand) {
  if (configured === 'observe') return 'observe';
  if (inShellCommand) return 'deny';
  if (configured === 'deny') return 'deny';
  if (configured === 'allow') return 'allow';
  return 'ask';
}

/**
 * @param {{name: string, arguments?: object, args?: object}} call
 * @param {object} rule the policy slice rules.secrets
 * @param {{v2?: boolean}} [opts] engine v2 reports the configured mode instead of clamping to ask
 * @returns {null | {rule: 'R3', mode: string, label: string, reason: string}}
 */
export function evaluateR3(call, rule = {}, opts = {}) {
  if (rule.mode === 'off') return null;
  const name = str(call?.name);
  const args = call?.arguments ?? call?.args ?? {};
  const strings = allStrings(args);

  for (const source of [...DEFAULT_SECRETS, ...(rule.patterns ?? [])]) {
    let re;
    try {
      re = new RegExp(source, 'i');
    } catch {
      continue;
    }
    for (const text of strings) {
      const hit = re.exec(text);
      if (!hit) continue;
      const label = labelFor(hit[0]);
      const inShellCommand = SHELL_TOOLS.has(name);
      const mode = opts.v2 === true
        ? modeForV2(rule.mode, inShellCommand)
        : (rule.mode === 'deny' || inShellCommand ? 'deny' : 'ask');
      return {
        rule: 'R3',
        mode,
        label,
        reason: mode === 'observe'
          ? `Guardrails R3: a secret (${label}) appears here; rules.secrets.mode is "observe", so this call is recorded instead of being refused. The secret is still a secret: move it to ~/.dsh/secrets/api-keys.json or an environment variable.`
          : mode === 'deny'
            ? `Guardrails R3: a secret (${label}) appears in a shell command, which was refused instead of shown. Do not put secrets in commands; write them to ~/.dsh/secrets/api-keys.json or an environment variable.`
            : `Guardrails R3: tool "${name}" appears to carry a secret (${label}); secrets must live in config files or environment variables, not in tool arguments or conversation.`,
      };
    }
  }
  return null;
}
