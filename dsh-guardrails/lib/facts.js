/**
 * Turn one tool call into language-neutral facts for the approval prompt.
 *
 * Pure with respect to DSH: it takes the call, the verdict and an environment
 * map; filesystem access is injected so tests never touch the disk.
 *
 * Facts are best-effort. Anything that cannot be proven is left undefined and
 * the renderer omits that segment — a wrong number is worse than no number.
 */

import { readdirSync, statSync } from 'node:fs';

import { expandPath } from '../rules.js';

const PATH_TOOLS = new Set(['write', 'edit', 'create_file', 'apply_patch']);
const SHELL_TOOLS = new Set(['pwsh', 'bash']);
const MAX_ENTRIES = 500;
const DISPLAY_PATH_MAX = 72;

/** Shell verbs, most specific first: registry/service before generic delete. */
const KIND_PATTERNS = [
  [/\breg\s+delete\b/i, 'registry'],
  [/\bsc\s+delete\b/i, 'service'],
  [/\b(?:remove-item|rmdir|ri|del|erase|rd|rm)\b/i, 'delete'],
  [/\b(?:move-item|rename-item|move|mv|ren|rename)\b/i, 'move'],
  [/\b(?:new-item|mkdir)\b/i, 'create'],
  [/\b(?:set-content|add-content|out-file|copy-item)\b/i, 'write'],
];

const PATH_FLAG = /-(?:literal)?path\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/i;
const QUOTED = /"([^"]+)"|'([^']+)'/g;
const LOOKS_LIKE_PATH = /^(?:[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/i;
const RECURSIVE = /(?:-recurse|\/mir\b|\/s\b)/i;

const REVERSIBLE = {
  delete: 'no',
  overwrite: 'no',
  registry: 'no',
  service: 'no',
  secret: 'no',
  move: 'yes',
  create: 'yes',
  write: 'unknown',
  plugin: 'unknown',
  unknown: 'unknown',
};

function str(value) {
  return typeof value === 'string' ? value : '';
}

/** Expand a user-supplied path for display, keeping the caller's casing. */
export function displayPath(raw, env) {
  const trimmed = str(raw).trim().replace(/^["']|["']$/g, '');
  if (trimmed === '') return '';
  const expanded = trimmed
    .replace(/^\$env:([A-Za-z_][A-Za-z0-9_]*)/i, (_, name) => str(env[name]) || str(env[name.toUpperCase()]))
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => str(env[name]) || str(env[name.toUpperCase()]))
    .replace(/^~(?=$|[\\/])/, str(env.USERPROFILE) || str(env.HOME) || '');
  return expanded.replace(/\//g, '\\');
}

/** Shorten a path for the headline; the audit log keeps the full value. */
export function clipPath(path) {
  if (path.length <= DISPLAY_PATH_MAX) return path;
  const head = Math.ceil((DISPLAY_PATH_MAX - 1) / 2);
  const tail = DISPLAY_PATH_MAX - 1 - head;
  return `${path.slice(0, head)}…${path.slice(-tail)}`;
}

/** First path-like argument of a tool call, if any. */
export function pathArgument(args) {
  if (args === null || typeof args !== 'object') return '';
  for (const key of ['file_path', 'filePath', 'path', 'target', 'destination']) {
    if (typeof args[key] === 'string' && args[key] !== '') return args[key];
  }
  return '';
}

/** Best-effort target extraction from a shell command line. */
export function commandTarget(command) {
  const text = str(command);
  if (text === '') return '';

  const flag = PATH_FLAG.exec(text);
  if (flag !== null) return flag[1] ?? flag[2] ?? flag[3] ?? '';

  for (const match of text.matchAll(QUOTED)) {
    const quoted = match[1] ?? match[2] ?? '';
    if (LOOKS_LIKE_PATH.test(quoted)) return quoted;
  }

  for (const token of text.split(/\s+/)) {
    const bare = token.replace(/^["']|["']$/g, '');
    if (LOOKS_LIKE_PATH.test(bare)) return bare;
  }
  return '';
}

/** Classify the action from the tool name and its arguments. */
export function classify(call, verdict) {
  const name = str(call?.name);
  const args = call?.arguments ?? {};

  if (verdict?.rule === 'R3') return 'secret';
  if (name === 'plugin_manager') return 'plugin';

  if (PATH_TOOLS.has(name)) {
    return pathArgument(args) === '' ? 'unknown' : 'write';
  }

  if (SHELL_TOOLS.has(name)) {
    const command = str(args.command ?? args.cmd ?? args.script);
    for (const [pattern, kind] of KIND_PATTERNS) {
      if (pattern.test(command)) return kind;
    }
    return 'unknown';
  }

  return 'unknown';
}

function underRoots(targetKey, roots) {
  if (targetKey === '') return undefined;
  return roots.some((root) => root !== '' && (targetKey === root || targetKey.startsWith(`${root}\\`)));
}

function safeStat(io, path) {
  try {
    return io.statSync(path);
  } catch {
    return undefined;
  }
}

function countEntries(io, path) {
  try {
    const entries = io.readdirSync(path);
    return entries.length > MAX_ENTRIES ? `${MAX_ENTRIES}+` : entries.length;
  } catch {
    return undefined;
  }
}

/**
 * Collect the facts behind one approval prompt.
 * @param {{name?: string, arguments?: object}} call tool call
 * @param {{rule?: string, label?: string} | null} verdict guardrail verdict
 * @param {object} env path environment ({ USERPROFILE, HOME, DSH_HOME, AGENTS_HOME })
 * @param {{roots?: string[], io?: {statSync: Function, readdirSync: Function}}} [options]
 */
export function collectFacts(call, verdict, env = {}, options = {}) {
  const io = options.io ?? { statSync, readdirSync };
  const roots = (options.roots ?? [])
    .map((root) => expandPath(root, env))
    .filter((root) => root !== '');

  const name = str(call?.name);
  const args = call?.arguments ?? {};
  const command = str(args.command ?? args.cmd ?? args.script);

  const kind = classify(call, verdict);
  const rawTarget = PATH_TOOLS.has(name) ? pathArgument(args) : commandTarget(command);
  const shown = displayPath(rawTarget, env);
  const key = shown === '' ? '' : expandPath(rawTarget, env);

  const stat = shown === '' ? undefined : safeStat(io, shown);
  const exists = stat === undefined ? undefined : true;
  const isDir = stat === undefined ? undefined : stat.isDirectory();

  let count;
  if (exists === true) {
    count = isDir === true ? countEntries(io, shown) : 1;
  }

  const resolvedKind = kind === 'write' ? (exists === true ? 'overwrite' : 'create') : kind;

  return {
    tool: name,
    kind: resolvedKind,
    target: shown,
    exists,
    isDir,
    count,
    recursive: RECURSIVE.test(command) ? true : undefined,
    reversible: REVERSIBLE[resolvedKind] ?? 'unknown',
    protectedHit: underRoots(key, roots),
    secretLabel: verdict?.rule === 'R3' ? str(verdict.label) : '',
  };
}
