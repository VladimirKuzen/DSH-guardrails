/**
 * Redaction for audit payloads that are allowed to spill.
 *
 * Only the observe path spills a payload that may hold a secret: the caller
 * stores the text with every secret-shaped run replaced by `<redacted:LABEL>`.
 * The result is re-scanned with the same list before anyone writes it, because
 * redaction and detection cannot stay isomorphic forever (case variants,
 * overlapping rules, truncation edges, a pattern that matches its own
 * placeholder). `clean === false` means "store nothing", not "store anyway".
 *
 * The pattern list is passed in, not imported alone: the detector runs
 * `DEFAULT_SECRETS` plus `policy.rules.secrets.patterns`, and a policy pattern
 * that is detected but redacted only against the built-in list would leak.
 */
import { DEFAULT_SECRETS, labelFor } from './rules/kit.js';

/**
 * Replace every secret-shaped run in `text` with `<redacted:LABEL>`.
 *
 * Labels match the detector's own naming (`labelFor`), so the audit label and
 * the card label stay one vocabulary. Length, offset and the value itself are
 * dropped on purpose: a label answers "which kind", nothing else.
 *
 * @param {string} text raw payload
 * @param {string[]} [extraPatterns] `rules.secrets.patterns` from the policy
 * @returns {{ text: string, labels: string[], clean: boolean }}
 */
export function redactSecrets(text, extraPatterns = []) {
  if (typeof text !== 'string' || text === '') return { text: '', labels: [], clean: true };
  const patterns = [...DEFAULT_SECRETS, ...extraPatterns.filter((p) => typeof p === 'string' && p !== '')];
  const labels = [];
  let out = text;
  for (const source of patterns) {
    let re;
    try {
      // 'g' so every occurrence is replaced; 'i' to match the detector's case rule.
      re = new RegExp(source, 'gi');
    } catch {
      continue;
    }
    out = out.replace(re, (hit) => {
      const label = labelFor(hit);
      if (!labels.includes(label)) labels.push(label);
      return `<redacted:${label}>`;
    });
  }
  // Re-scan exactly like the detector does ('i' only). A global regexp carries
  // `lastIndex` state between test() calls, which would silently skip matches.
  const clean = patterns.every((source) => {
    try {
      return !new RegExp(source, 'i').test(out);
    } catch {
      return true;
    }
  });
  return { text: out, labels, clean };
}
