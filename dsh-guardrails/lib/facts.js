/**
 * Turn one tool call into language-neutral facts for the approval prompt.
 * 把一次工具调用整理成与语言无关的事实，供审批卡片渲染。
 *
 * Pure with respect to DSH: it takes the call, the verdict and an environment
 * map; filesystem access is injected so tests never touch the disk.
 *
 * Facts are best-effort. Anything that cannot be proven is left undefined and
 * the renderer omits that segment — a wrong number is worse than no number.
 */

import { readdirSync, statSync } from 'node:fs';

import { expandPath } from '../rules.js';
import { isProgramMention } from './rules/kit.js';

const PATH_TOOLS = new Set(['write', 'edit', 'create_file', 'apply_patch']);
const SHELL_TOOLS = new Set(['pwsh', 'bash']);
const MAX_ENTRIES = 500;
const DISPLAY_PATH_MAX = 72;

/** Shell verbs, most specific first: registry/service before generic delete. */
const KIND_PATTERNS = [
  [/\breg(?:\.exe)?\s+(?:delete|add|import|load|restore)\b/i, 'registry'],
  [/\b(?:set-itemproperty|new-itemproperty|remove-itemproperty|new-item|remove-item)\b[^\n]*hk(?:lm|cu|cr|u|cc):/i, 'registry'],
  [/\bsc(?:\.exe)?\s+(?:delete|create|config|failure)\b|\b(?:new|set)-service\b/i, 'service'],
  [/\bschtasks(?:\.exe)?\s+\/(?:create|change|delete|run)\b/i, 'scheduled'],
  [/\bnetsh\s+advfirewall\b|\b(?:set|new|add)-mppreference\b/i, 'firewall'],
  [/\b(?:remove-item|rmdir|ri|del|erase|rd|rm)\b/i, 'delete'],
  [/\b(?:move-item|rename-item|move|mv|ren|rename)\b/i, 'move'],
  [/\b(?:new-item|mkdir)\b/i, 'create'],
  [/\b(?:set-content|add-content|out-file|copy-item)\b/i, 'write'],
];

/**
 * How bad a kind is, for choosing which action the card describes.
 * A command that creates a directory and then deletes files is a delete.
 */
const KIND_RANK = new Map([
  ['delete', 6],
  ['registry', 5],
  ['service', 5],
  ['scheduled', 5],
  ['firewall', 5],
  ['move', 4],
  ['write', 3],
  ['create', 2],
]);

/** A path flag, but not the "-Path" inside "Join-Path" or "Split-Path". */
const PATH_FLAG = /(?<![\w-])-(?:literal)?path\b\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/i;
const QUOTED = /"([^"]+)"|'([^']+)'/g;
/** A Windows path: drive-rooted or UNC. A bare "/v" is a CLI switch, not a path. */
const LOOKS_LIKE_WINDOWS = /^(?:[a-z]:[\\/]|\\\\)/i;
/** Unix-style paths only make sense for the bash tool. */
const LOOKS_LIKE_ANY = /^(?:[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/i;
/** A registry key, e.g. HKCU\Software\Foo or HKLM:\SYSTEM (either provider syntax). */
const REG_KEY = /\bhk(?:lm|cu|cr|u|cc)[:\\][^\s"';|&]+/i;
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
  scheduled: 'unknown',
  firewall: 'unknown',
  disk: 'no',
  boot: 'no',
  systemfiles: 'no',
  permissions: 'no',
  custom: 'unknown',
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

/** First registry key mentioned by a command, if any. */
export function registryKey(command) {
  const match = REG_KEY.exec(str(command));
  return match === null ? '' : match[0];
}

/** The registry sub-action behind a registry-kind statement: add / delete / import / load / restore. */
export function registryVerb(statement) {
  const text = str(statement);
  const direct = /\breg(?:\.exe)?\s+(add|delete|import|load|restore)\b/i.exec(text);
  if (direct !== null) return direct[1].toLowerCase();
  if (!/\bhk(?:lm|cu|cr|u|cc):/i.test(text)) return '';
  if (/\b(?:set|new|add)-itemproperty\b|\bnew-item\b/i.test(text)) return 'add';
  if (/\b(?:remove-item|remove-itemproperty|clear-item)\b/i.test(text)) return 'delete';
  return '';
}

/** Best-effort target extraction from one statement or command line. */
export function commandTarget(command, options = {}) {
  const text = str(command);
  if (text === '') return '';

  // `reg add HKCU\…` has no path-like token at all: the key is the target.
  const key = registryKey(text);
  if (key !== '') return key;

  const flag = PATH_FLAG.exec(text);
  if (flag !== null) return flag[1] ?? flag[2] ?? flag[3] ?? '';

  const pathLike = options.unix === true ? LOOKS_LIKE_ANY : LOOKS_LIKE_WINDOWS;

  for (const match of text.matchAll(QUOTED)) {
    const quoted = match[1] ?? match[2] ?? '';
    if (pathLike.test(quoted)) return quoted;
  }

  for (const token of text.split(/\s+/)) {
    const bare = token.replace(/^["']|["']$/g, '');
    if (pathLike.test(bare)) return bare;
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

/**
 * The worst recognised action in a command, not merely the first.
 * `New-Item …; Remove-Item …` must read as a delete: a card that names the
 * harmless first step hides the irreversible one. Ties keep the earliest.
 */
export function worstActionStatement(command) {
  let worst = { statement: '', kind: 'unknown', rank: 0 };
  for (const statement of splitStatements(command)) {
    for (const [pattern, kind] of KIND_PATTERNS) {
      if (!pattern.test(statement)) continue;
      const rank = KIND_RANK.get(kind) ?? 1;
      if (rank > worst.rank) worst = { statement, kind, rank };
      break;
    }
  }
  return { statement: worst.statement, kind: worst.kind };
}

/**
 * First path under DSH's home that a command actually writes, displayed.
 *
 * A `.dsh` path in program position is a path being run (the bundled node, a script under the
 * runtime), never the object of the nearby write verb: `& '…\.dsh\…\node.exe' x.mjs; Set-Content
 * out.txt` must not describe node.exe as the target.
 */
export function protectedPath(command, env) {
  const text = str(command);
  for (const pattern of [PROTECTED_ABS, PROTECTED_VAR]) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace(/g/g, '')}g`);
    let match;
    while ((match = global.exec(text)) !== null) {
      if (isProgramMention(text, match.index)) continue;
      const shown = displayPath(match[0], env);
      return isUnresolved(shown) ? '' : shown;
    }
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
    return worstActionStatement(command).kind;
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

  const action = shell ? worstActionStatement(command) : { statement: '', kind: '' };
  let kind = classify(call, verdict);
  // Reserved for a future rule that gates directory creation itself. Under the
  // current rules a shell `New-Item -ItemType Directory` is only gated when it
  // touches DSH's home, and that case is rendered as "protected" below.
  if (shell && kind === 'create' && DIRECTORY_ITEM.test(action.statement)) kind = 'create-dir';

  // A shell command that touches DSH's home is described by that path: the
  // command may act on several paths, and the protected one is the reason it
  // was gated at all.
  const protectedTarget = shell && verdict?.rule === 'R1' ? protectedPath(command, env) : '';
  if (protectedTarget !== '') kind = 'protected';

  // Registry writes split into add / delete / import: only deletion is really irreversible.
  const registryAction = kind === 'registry' ? registryVerb(action.statement) : '';

  // A critical verdict knows its own target (the system path it matched).
  const criticalCategory = verdict?.severity === 'critical' ? str(verdict.category) : '';
  const criticalTarget = criticalCategory === '' ? '' : str(verdict.target);

  const rawTarget = criticalTarget !== ''
    ? criticalTarget
    : protectedTarget !== ''
      ? protectedTarget
      : PATH_TOOLS.has(name)
        ? pathArgument(args)
        : commandTarget(action.statement, { unix: name === 'bash' });

  const shown = displayPath(rawTarget, env);
  // A target still carrying a variable cannot be named. Say so instead of
  // silently dropping the segment: "delete, target unknown" is still a fact.
  const unresolved = shown !== '' && isUnresolved(shown);
  const target = unresolved ? '' : shown;
  const dynamic = unresolved ? true : undefined;
  // A wildcard means the text names a pattern, not one key or file.
  const wildcard = /[*?]/.test(rawTarget) ? true : undefined;
  const lineCount = shell ? command.split(/\r?\n/).filter((line) => line.trim() !== '').length : 0;

  const stat = target === '' ? undefined : safeStat(io, target);
  const exists = stat === undefined ? undefined : true;
  const isDir = stat === undefined ? undefined : stat.isDirectory();

  const recursive = RECURSIVE.test(command) ? true : undefined;
  const resolvedKind = kind === 'write' ? (exists === true ? 'overwrite' : 'create') : kind;
  const reversible = criticalCategory !== ''
    ? 'no'
    : kind === 'registry'
      // Adding a key/value can be undone; overwriting an existing value cannot be
      // proven from text, so it stays "not assessed" instead of a wrong "no".
      ? (registryAction === 'delete' ? 'no' : 'unknown')
      : (REVERSIBLE[resolvedKind] ?? 'unknown');

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
    reversible,
    registryAction,
    wildcard,
    protectedHit: protectedTarget !== '' ? true : underRoots(expandPath(rawTarget, env), roots),
    secretLabel: verdict?.rule === 'R3' ? str(verdict.label) : '',
    severity: criticalCategory === '' ? undefined : 'critical',
    criticalCategory,
    ...(dynamic === undefined ? {} : { dynamic }),
  };
}
