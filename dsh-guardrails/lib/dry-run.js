/**
 * Two-stage approval for commands a card cannot describe.
 * 卡片装不下的命令改走两步：先拒绝并要一份只读清单，重试时才弹卡。
 *
 * The approval card carries one line of requester-owned text; the host renders
 * tool arguments itself and truncates long commands. When the arguments say
 * less than nothing (a loop over a variable, forty lines of setup) the human is
 * asked to approve a shape, not an action. The fix is not a longer string: the
 * gate refuses the call once, tells the model to enumerate what it will touch,
 * and shows the ordinary card on the retry — with that enumeration above it in
 * the transcript.
 *
 * This is a nudge, not a proof: the gate cannot tell whether the model ran the
 * listing. It only guarantees the human gets one chance to see it.
 */

import { createHash } from 'node:crypto';

import { DEFAULT_DESTRUCTIVE, SHELL_TOOLS, str } from './rules/kit.js';

/** Kinds where "what exactly" matters: the operation changes existing state. */
const RISKY_KINDS = new Set(['delete', 'move', 'overwrite', 'rename']);

export const DEFAULT_DRY_RUN = Object.freeze({
  enabled: false,
  minChars: 400,
  minStatements: 3,
  dynamicTarget: true,
});

/** A stable id for one command shape, used to spot the retry. */
export function fingerprint(tool, command) {
  return createHash('sha256').update(`${str(tool)}\n${str(command)}`).digest('hex').slice(0, 16);
}

/** How many statements in this command are destructive in their own right. */
export function destructiveStatements(command, patterns = DEFAULT_DESTRUCTIVE) {
  // Patterns in the policy are regular expressions serialized as strings, so a
  // RegExp handed in by a caller works the same way as one from kit.js.
  const compiled = patterns.map((pattern) =>
    pattern instanceof RegExp ? pattern : new RegExp(str(pattern), 'i'),
  );
  let count = 0;
  for (const statement of str(command).split(/\r?\n|;|&&|\|\||\|/)) {
    const trimmed = statement.trim();
    if (trimmed === '') continue;
    if (compiled.some((pattern) => pattern.test(trimmed))) count += 1;
  }
  return count;
}

/**
 * Why this call needs a dry run first, or null.
 * @param {{tool?: string, command?: unknown, facts?: object | null, config?: object}} input
 * @returns {null | {trigger: 'dynamic-target' | 'long' | 'many', chars: number, statements: number}}
 */
export function dryRunRequirement({ tool, command, facts, config }) {
  const settings = { ...DEFAULT_DRY_RUN, ...(config ?? {}) };
  if (settings.enabled !== true) return null;
  if (!SHELL_TOOLS.has(str(tool))) return null;
  if (facts === null || typeof facts !== 'object') return null;
  if (!RISKY_KINDS.has(str(facts.kind))) return null;

  const text = str(command);
  const chars = text.length;
  const statements = destructiveStatements(text);

  // A target we cannot name is the case the card handles worst: the human sees
  // "delete" and nothing else.
  if (settings.dynamicTarget === true && str(facts.target) === '') {
    return { trigger: 'dynamic-target', chars, statements };
  }
  if (chars > Number(settings.minChars)) return { trigger: 'long', chars, statements };
  if (statements >= Number(settings.minStatements)) return { trigger: 'many', chars, statements };
  return null;
}

/** The refusal the model reads. It must not sound like a safety verdict. */
export function dryRunMessage(requirement) {
  const why = {
    'dynamic-target': 'its target depends on a variable, so the approval card cannot name it',
    long: `it is ${requirement.chars} characters long, which the approval card cannot show`,
    many: `it runs ${requirement.statements} destructive steps in one call`,
  }[requirement.trigger];
  return `Guardrails R2: this call needs a dry run before it can be approved — ${why}. `
    + 'Run a read-only listing of the exact paths it will touch (or state them explicitly), then retry the same call; '
    + 'it will then be shown for approval. The operation itself was not judged unsafe.';
}
