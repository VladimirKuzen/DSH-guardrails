/**
 * R3: secrets in tool arguments.
 * R3：工具参数里的密钥。
 *
 * Shell commands are refused outright: the host echoes a command verbatim in its
 * approval card, so asking about one would display the secret. A file write has
 * no such echo and may still be approved, with the label only.
 */

import { DEFAULT_SECRETS, SHELL_TOOLS, allStrings, labelFor, str } from './kit.js';

/**
 * @param {{name: string, arguments?: object, args?: object}} call
 * @param {object} rule the policy slice rules.secrets
 * @returns {null | {rule: 'R3', mode: string, label: string, reason: string}}
 */
export function evaluateR3(call, rule = {}) {
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
      const mode = rule.mode === 'deny' || inShellCommand ? 'deny' : 'ask';
      return {
        rule: 'R3',
        mode,
        label,
        reason: mode === 'deny'
          ? `Guardrails R3: a secret (${label}) appears in a shell command, which was refused instead of shown. Do not put secrets in commands; write them to ~/.dsh/secrets/api-keys.json or an environment variable.`
          : `Guardrails R3: tool "${name}" appears to carry a secret (${label}); secrets must live in config files or environment variables, not in tool arguments or conversation.`,
      };
    }
  }
  return null;
}
