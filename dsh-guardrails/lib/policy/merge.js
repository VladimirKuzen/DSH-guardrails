/**
 * Deep merge used to layer the policy file over the built-in defaults.
 *
 * Lives in its own module so the `check` CLI merges exactly like the host does;
 * a CLI that merged differently would disagree with the runtime on calls that
 * rely on a default the file does not repeat.
 */

/** Deep merge: matching keys in the file override defaults; missing keys keep theirs. */
export function merge(base, override) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base && base[key] !== null && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? merge(base[key], value)
      : value;
  }
  return out;
}
