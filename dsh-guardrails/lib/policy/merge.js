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

/**
 * Move `rules.destructive.workspaceQuiet` to `rules.quiet`.
 *
 * The setting decides whether a card is shown at all; it never was a property
 * of the destructive matcher, it only lived there because P1.7 got there first.
 * The old location keeps working (a config that spells it there must not change
 * behaviour on upgrade), but every reader looks at `rules.quiet` only, so there
 * is one place to change. `rules.quiet` wins when both are present; the
 * validator rejects that combination so it cannot silently pick one.
 */
export function applyAliases(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return policy;
  const rules = policy.rules;
  if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) return policy;
  const legacy = rules.destructive?.workspaceQuiet;
  if (legacy === undefined) return policy;

  const { workspaceQuiet, ...destructive } = rules.destructive;
  return {
    ...policy,
    rules: {
      ...rules,
      ...(rules.quiet === undefined ? { quiet: legacy } : {}),
      destructive,
    },
  };
}
