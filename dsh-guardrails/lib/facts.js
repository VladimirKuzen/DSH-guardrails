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

/** A path flag, but not the "-Path" inside "Join-Path" or "Split-Path". */
const PATH_FLAG = /(?<![\w-])-(?:literal)?path\b\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/i;
const QUOTED = /"([^"]+)"|'([^']+)'/g;
const LOOKS_LIKE_PATH = /^(?:[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/i;
const RECURSIVE = /(?:-recurse|\/mir\b|\/s\b)/i;
const DIRECTORY_ITEM = /-itemtype\s+directory\b/i;

/** A path under DSH's own home, whether absolute or written through a variable. */
const PROTECTED_ABS = /[A-Za-z]:\\[^"'\r\n]*?\.(?:dsh|agents)(?:\\[^"'\r\n]*)?/i;
const PROTECTED_VAR = /(?:~|\$env:USERPROFILE|%USERPROFILE%)[\\/]\.(?:dsh|agents)[^"'\r\n]*/i;

const REVERSIBLE = {
  delete: 'no',
  overwrite: 'no',
  registry: 'no',
  service: 'no',
  secret: 'no',
  move: 'yes',
  create: 'yes',
  'create-dir': 'yes',
  write: 'unknown',
  plugin: 'unknown',
  protected: 'unknown',
  unknown: 'unknown',
};

function str(value) {
  return typeof value === 'string' ? value : '';
}

/** Expand a user-supplied path for display, keeping the caller's casing. */
export function displayPath(raw, env) {
  const trimmed = str(raw).trim().replace(/^["']|["']$/g, '');
  if (trimmed === '') return '';

  const lookup = (name) => str(env[name]) || str(env[name.toUpperCase()]);
  const expanded = trimmed
    .replace(/^\$env:([A-Za-z_][A-Za-z0-9_]*)/i, (match, name) => lookup(name) || match)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => lookup(name) || match)
    .replace(/^~(?=$|[\\/])/, (match) => str(env.USERPROFILE) || str(env.HOME) || match);
  return expanded.replace(/\//g, '\\');
}

/** A value still carrying a variable is not a usable target. */
export function isUnresolved(value) {
  return value.includes('$') || /%[A-Za-z_][A-Za-z0-9_]*%/.test(value);
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

/** Best-effort target extraction from one statement or command line. */
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

/** Split a shell command into statements we can reason about one at a time. */
export function splitStatements(command) {
  return str(command)
    .split(/\r?\n|;|&&|\|\||\|/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** The first statement that carries a recognised action, with its kind. */
export function actionStatement(command) {
  for (const statement of splitStatements(command)) {
    for (const [pattern, kind] of KIND_PATTERNS) {
      if (pattern.test(statement)) return { statement, kind };
    }
  }
  return { statement: '', kind: 'unknown' };
}

/** First path under DSH's home mentioned by a command, displayed. */
export function protectedPath(command, env) {
  const text = str(command);
  const match = PROTECTED_ABS.exec(text) ?? PROTECTED_VAR.exec(text);
  if (match === null) return '';
  const shown = displayPath(match[0], env);
  return isUnresolved(shown) ? '' : shown;
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
    return actionStatement(command).kind;
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
 * @param {object} env path environment ({ USERPROFILE, HOME, DSH_HOME, AGENTS_HOME, ... })
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
  const shell = SHELL_TOOLS.has(name);

  const action = shell ? actionStatement(command) : { statement: '', kind: '' };
  let kind = classify(call, verdict);
  if (shell && kind === 'create' && DIRECTORY_ITEM.test(action.statement)) kind = 'create-dir';

  // A shell command that touches DSH's home is described by that path: the
  // command may act on several paths, and the protected one is the reason it
  // was gated at all.
  const protectedTarget = shell && verdict?.rule === 'R1' ? protectedPath(command, env) : '';
  if (protectedTarget !== '') kind = 'protected';

  const rawTarget = protectedTarget !== ''
    ? protectedTarget
    : PATH_TOOLS.has(name)
      ? pathArgument(args)
      : commandTarget(action.statement);

  const shown = displayPath(rawTarget, env);
  const target = isUnresolved(shown) ? '' : shown;
  const lineCount = shell ? command.split(/\r?\n/).filter((line) => line.trim() !== '').length : 0;

  const stat = target === '' ? undefined : safeStat(io, target);
  const exists = stat === undefined ? undefined : true;
  const isDir = stat === undefined ? undefined : stat.isDirectory();

  const recursive = RECURSIVE.test(command) ? true : undefined;
  const resolvedKind = kind === 'write' ? (exists === true ? 'overwrite' : 'create') : kind;

  let count;
  if (exists === true) {
    if (isDir !== true) count = 1;
    else if (resolvedKind === 'delete' && recursive === true) count = countEntries(io, target);
    else if (resolvedKind === 'move') count = countEntries(io, target);
  }

  return {
    tool: name,
    kind: resolvedKind,
    target,
    exists,
    isDir,
    count,
    recursive,
    lines: lineCount,
    reversible: REVERSIBLE[resolvedKind] ?? 'unknown',
    protectedHit: protectedTarget !== '' ? true : underRoots(expandPath(rawTarget, env), roots),
    secretLabel: verdict?.rule === 'R3' ? str(verdict.label) : '',
  };
}
