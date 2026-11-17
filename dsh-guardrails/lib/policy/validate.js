/**
 * Policy validation: the JSON Schema subset in policy.schema.json, plus the
 * rules a schema cannot express (version gating, entry narrowing, path shape).
 * 策略校验：policy.schema.json 的 JSON Schema 子集 + schema 表达不了的语义规则
 * （版本门禁、条目收窄、路径形状）。
 *
 * A policy that fails here is not merged into defaults — the previous good
 * policy stays live, because a mistyped key must not silently disable a rule.
 * 校验失败的策略不会被并入默认值：保留上一份好策略，因为一个拼错的键
 * 不能悄悄关掉一条规则。
 *
 * The validator is hand-written on purpose: the plugin has no runtime
 * dependencies, and the subset below is all the schema uses.
 */

import { readFileSync } from 'node:fs';

export const SCHEMA = JSON.parse(readFileSync(new URL('../../policy.schema.json', import.meta.url), 'utf8'));

/** Highest policy version this release understands. 2 selects the ranked engine. */
export const SUPPORTED_VERSION = 2;

const at = (path, index) => `${path}[${index}]`;
const join = (path, key) => (path === '' ? key : `${path}.${key}`);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(type, value) {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeOf(value) === type;
}

/** True when the value satisfies the branch without reporting anything. */
function valid(schema, value) {
  const scratch = [];
  check(schema, value, '', scratch);
  return scratch.length === 0;
}

/** Walk one schema node, collecting { path, code, message } errors. */
function check(schema, value, path, errors) {
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    errors.push({ path, code: 'type', message: `expected ${schema.type}, got ${typeOf(value)}` });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    errors.push({
      path,
      code: 'enum',
      message: `expected one of ${schema.enum.join(', ')}, got ${JSON.stringify(value)}`,
    });
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((branch) => valid(branch, value)).length;
    if (matched !== 1) {
      errors.push({ path, code: 'oneOf', message: `must match exactly one of ${schema.oneOf.length} shapes, matched ${matched}` });
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, code: 'minLength', message: `must be at least ${schema.minLength} character(s)` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, code: 'pattern', message: `must match ${schema.pattern}` });
    }
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path, code: 'minimum', message: `must be >= ${schema.minimum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, code: 'minItems', message: `must have at least ${schema.minItems} item(s)` });
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => check(schema.items, item, at(path, index), errors));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) errors.push({ path: join(path, required), code: 'required', message: 'is required' });
    }
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) check(properties[key], item, join(path, key), errors);
      else if (schema.additionalProperties === false) {
        errors.push({ path: join(path, key), code: 'unknown-key', message: `unknown key "${key}"` });
      }
    }
  }
}

/** Absolute or expandable (drive letter, UNC, ~/, %VAR%/, $env:VAR/) and no ".." segment. */
function pathProblem(value) {
  if (value.includes('..')) return 'must not contain ".." segments';
  const absolute = /^(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|%[A-Za-z_][A-Za-z0-9_]*%[\\/]|\$env:[A-Za-z_][A-Za-z0-9_]*[\\/])/;
  if (!absolute.test(value)) return 'must be an absolute path (drive letter, UNC, ~/, %VAR%/ or $env:VAR/)';
  return '';
}

/**
 * Validate a parsed policy file (before merging with DEFAULTS).
 * @param {unknown} policy
 * @returns {{ok: boolean, errors: Array<{path: string, code: string, message: string}>}}
 */
export function validatePolicy(policy) {
  const errors = [];
  check(SCHEMA, policy, '', errors);
  if (errors.length > 0) return { ok: false, errors };

  if (policy.version !== undefined && !(policy.version <= SUPPORTED_VERSION)) {
    errors.push({
      path: 'version',
      code: 'unsupported-version',
      message: `version ${policy.version} is not supported by this release; only version ${SUPPORTED_VERSION} is accepted`,
    });
  }

  const rules = policy.rules ?? {};
  for (const [name, rule] of Object.entries(rules)) {
    if (rule?.mode === 'allow' && policy.version !== 2) {
      errors.push({
        path: `rules.${name}.mode`,
        code: 'allow-requires-v2',
        message: '"allow" is only a rule mode under policy version 2, where it really lets calls through; '
          + 'in version 1 it would be clamped to ask, so it is rejected instead of silently ignored',
      });
    }
    if (name === 'critical' && rule !== null && typeof rule === 'object'
      && rule.mode !== undefined && !['ask', 'deny', 'off'].includes(rule.mode)) {
      errors.push({
        path: 'rules.critical.mode',
        code: 'critical-mode-invalid',
        message: `critical operations accept only "ask", "deny" or "off"; "${rule.mode}" would let a disk/boot/registry operation through without a card`,
      });
    }
    if (rule?.mode === 'observe' && policy.version !== 2) {
      errors.push({
        path: `rules.${name}.mode`,
        code: 'observe-requires-v2',
        message: '"observe" only means something under policy version 2; in version 1 it would be clamped to ask, so it is rejected instead of silently ignored',
      });
    }
    if (name === 'selfProtect' && rule !== null && typeof rule === 'object' && rule.mode === 'off') {
      errors.push({ path: 'rules.selfProtect.mode', code: 'self-protect-not-disableable', message: 'self-protection cannot be switched off by the file it protects; use deny to make it stricter' });
    }
  }

  if (rules.quiet !== undefined && rules.destructive?.workspaceQuiet !== undefined) {
    errors.push({
      path: 'rules.quiet',
      code: 'quiet-duplicate',
      message: 'workspaceQuiet moved to rules.quiet; keep one of them, not both — two copies would drift and the reader only sees rules.quiet',
    });
  }

  const entryIds = new Set();
  for (const [index, entry] of (Array.isArray(policy.entries) ? policy.entries : []).entries()) {
    const base = at('entries', index);
    if (typeof entry?.id === 'string') {
      if (entryIds.has(entry.id)) {
        errors.push({ path: `${base}.id`, code: 'duplicate-id', message: `"${entry.id}" is used by an earlier entry` });
      }
      entryIds.add(entry.id);
    }
    if (policy.version !== 2) {
      errors.push({ path: base, code: 'entries-require-v2', message: 'entries are only read by engine v2; set "version": 2 to use them (with version 1 they would be ignored, so the file is rejected instead)' });
    }
    const when = entry?.when ?? {};
    const narrowing = ['cwdUnder', 'targetUnder', 'commandMatches'].filter((key) => when[key] !== undefined).length;
    if (entry?.mode === 'allow' && narrowing === 0) {
      errors.push({ path: `${base}.when`, code: 'allow-needs-narrowing', message: 'an "allow" entry must narrow the tools it covers with at least one of cwdUnder / targetUnder / commandMatches' });
    }
    for (const key of ['cwdUnder', 'targetUnder']) {
      for (const [pathIndex, value] of (when[key] ?? []).entries()) {
        const problem = pathProblem(`${value}`);
        if (problem !== '') errors.push({ path: `${base}.when.${key}[${pathIndex}]`, code: 'path-shape', message: `${value}: ${problem}` });
      }
    }
    if (typeof when.commandMatches === 'string') {
      if (!when.commandMatches.startsWith('^')) {
        errors.push({ path: `${base}.when.commandMatches`, code: 'command-matches-unanchored', message: 'must start with "^" so it cannot match in the middle of a command' });
      }
      try {
        new RegExp(when.commandMatches);
      } catch (error) {
        errors.push({ path: `${base}.when.commandMatches`, code: 'command-matches-invalid', message: `does not compile: ${error?.message ?? error}` });
      }
    }
  }

  for (const [index, value] of (rules.selfProtect?.paths ?? []).entries()) {
    const problem = pathProblem(`${value}`);
    if (problem !== '') errors.push({ path: `rules.selfProtect.paths[${index}]`, code: 'path-shape', message: `${value}: ${problem}` });
  }

  return { ok: errors.length === 0, errors: errors.slice(0, 8) };
}

/** One-line summary for a log line or an audit `reason`. */
export function describeErrors(errors) {
  const shown = errors.slice(0, 3).map((error) => `${error.path === '' ? '(root)' : error.path}: ${error.message}`);
  const rest = errors.length > 3 ? ` (+${errors.length - 3} more)` : '';
  return `${shown.join('; ')}${rest}`;
}

/** Stable key for "already warned about this" bookkeeping. */
export function errorSignature(errors) {
  const first = errors[0];
  return first === undefined ? '' : `${first.path}|${first.code}`;
}
