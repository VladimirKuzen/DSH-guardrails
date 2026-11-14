/**
 * Windows critical operations: the subset that is refused instead of asked.
 *
 * These are the operations where one "allow once" click can leave the machine
 * unbootable or erase a disk, and where the model cannot see what it needs to
 * judge the target (disk numbers, partition layout, hive contents). They are
 * refused so the user goes back to their own terminal with the real console.
 *
 * Pure: no filesystem access, no events, no imports from the rule engine.
 * Returns a category and a short detail, or null when nothing matched.
 */

const DISK_TOOL = /(?:^|[\n;&|(){])\s*(format(?:\.(?:com|exe))?)(?=\s|$)/i;
const DISK_CMDLET = /\b(format-volume|clear-disk|initialize-disk|remove-partition)\b/i;
const DISKPART_CALL = /(?:^|[\n;&|(){])\s*diskpart(?:\.exe)?\b/i;

/** Verbs that make a diskpart invocation destructive. */
const DISKPART_VERB = /\b(clean(?:\s+all)?|format|create\s+partition|delete\s+partition|create\s+volume|delete\s+volume|create\s+vdisk|delete\s+vdisk|convert)\b/i;

/** Boot configuration writers: read-only switches are not in this list. */
const BOOT_WRITER = [
  /\b(bcdedit)(?:\.exe)?\b[^\n]*\/(set|delete|create|import|export)\b/i,
  /\b(bootrec)(?:\.exe)?\b[^\n]*\/(fixmbr|fixboot|rebuildbcd)\b/i,
  /\b(vssadmin)(?:\.exe)?\b[^\n]*\bdelete\b/i,
  /\b(wbadmin)(?:\.exe)?\b[^\n]*\bdelete\b/i,
  /\b(reagentc)(?:\.exe)?\b[^\n]*\/(disable|enable|setreimage|setosimage)\b/i,
];

/** Registry hives whose deletion can keep Windows from booting. */
const HIVE_DELETE = /(?:^|[\n;&|(){])\s*reg(?:\.exe)?\s+delete\s+"?hklm\\(system|sam)\b/i;
const HIVE_DELETE_PROVIDER = /\b(?:remove-item|remove-itemproperty|clear-item)\b[^\n]*hklm:\\?(system|sam)\b/i;

/** Verbs that destroy or replace the contents of a path. */
const WRITE_OR_DELETE = /\b(?:remove-item|ri|rm|del|erase|rd|rmdir|clear-content|set-content|add-content|out-file|copy-item|move-item|move|cp|mv|copy|xcopy|robocopy)\b|(?<![=<>-])>(?!>)\s*[A-Za-z"$%]/i;

/** For copy-like verbs only the destination matters: backing up a system file is fine.
 *  Move is not in this list: moving a system file away also removes it. */
const COPY_LIKE = /\b(?:copy-item|cp|copy|xcopy|robocopy)\b/i;

const PERMISSION_TOOL = /\b(?:takeown|icacls)(?:\.exe)?\b/i;

const STATEMENT_SPLIT = /\r?\n|;|&&|\|\||[|&]/;
const TOKEN = /"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;|&<>]+)/g;
const PATH_LIKE = /^(?:[a-z]:[\\/]|\\\\|\.{1,2}[\\/]|%[a-z_][a-z0-9_()]*%|\$env:)/i;

const FALLBACK_ROOTS = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)'];

/** Read-only diagnostics, allowed so the agent can still inspect a machine. */
const READONLY_LINE = [
  /^bcdedit(?:\.exe)?\b[^\n]*\/(?:enum|v)\b/i,
  /^bootrec(?:\.exe)?\b[^\n]*\/scanos\b/i,
  /^vssadmin(?:\.exe)?\b[^\n]*\blist\b/i,
  /^reagentc(?:\.exe)?\b[^\n]*\/info\b/i,
  /^get-(?:disk|partition|volume|physicaldisk)\b/i,
  /^select\s+(?:disk|volume|partition|vdisk)\b/i,
  /^(?:select-object|where-object|sort-object|format-table|format-list|measure-object)\b/i,
];

function str(value) {
  return typeof value === 'string' ? value : '';
}

function statements(command) {
  return str(command)
    .split(STATEMENT_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Case-insensitive environment lookup: Windows keeps the original key casing. */
function envValue(env, name) {
  if (typeof env[name] === 'string' && env[name] !== '') return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined || typeof env[key] !== 'string' ? '' : env[key];
}

/** Expand variables and normalise separators; unknown variables stay literal. */
function expand(raw, env) {
  let path = str(raw).trim().replace(/^["']|["']$/g, '');
  if (path === '') return '';
  path = path
    .replace(/^\$env:([A-Za-z_][A-Za-z0-9_]*)/i, (match, name) => envValue(env, name) || match)
    .replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (match, name) => envValue(env, name) || match)
    .replace(/^~(?=$|[\\/])/, () => envValue(env, 'USERPROFILE') || '')
    .replace(/\//g, '\\')
    .replace(/\\{2,}/g, '\\');
  return path.toLowerCase();
}

function trimSlash(path) {
  return path.replace(/\\+$/, '');
}

/** System directories: every path below them is refused for writes/deletes. */
export function systemRoots(env = {}) {
  const values = [
    envValue(env, 'SystemRoot') || envValue(env, 'windir'),
    envValue(env, 'ProgramFiles') || envValue(env, 'ProgramW6432'),
    envValue(env, 'ProgramFiles(x86)'),
  ].filter((value) => value !== '');

  const roots = values.map((value) => trimSlash(expand(value, env)));
  return roots.length === 0 ? FALLBACK_ROOTS : roots;
}

function isUnder(path, roots) {
  if (path === '') return false;
  return roots.some((root) => path === root || path.startsWith(`${root}\\`));
}

function pathCandidates(statement, depth = 0) {
  const found = [];
  for (const match of statement.matchAll(TOKEN)) {
    const quoted = (match[1] ?? match[2] ?? '').replace(/\)+$/, '');
    if (quoted !== '') {
      if (PATH_LIKE.test(quoted)) found.push(quoted);
      // `cmd /c "del C:\Windows\x"` hides the path inside a nested command.
      else if (depth < 2) found.push(...pathCandidates(quoted, depth + 1));
      continue;
    }
    const bare = (match[3] ?? '').replace(/\)+$/, '');
    if (PATH_LIKE.test(bare)) found.push(bare);
  }
  return found;
}

function firstMatch(command, patterns) {
  for (const pattern of patterns) {
    const hit = pattern.exec(command);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Detect a Windows critical operation.
 * @param {string} command shell command text
 * @param {object} env environment with SystemRoot / ProgramFiles / USERPROFILE
 * @returns {null | {category: string, detail: string, target: string}}
 */
export function criticalVerdict(command, env = {}) {
  const text = str(command);
  if (text.trim() === '') return null;

  // --- Disk-level: formatting, initialising, deleting partitions, diskpart scripts
  const disk = DISK_TOOL.exec(text) ?? DISK_CMDLET.exec(text);
  if (disk !== null) return { category: 'disk', detail: disk[1].toLowerCase(), target: '' };

  if (DISKPART_CALL.test(text)) {
    if (/\/s\b/i.test(text)) return { category: 'disk', detail: 'diskpart /s', target: '' };
    const verb = DISKPART_VERB.exec(text);
    if (verb !== null) return { category: 'disk', detail: `diskpart ${verb[1].toLowerCase()}`, target: '' };
  }

  // --- Boot configuration
  const boot = firstMatch(text, BOOT_WRITER);
  if (boot !== null) {
    const detail = `${boot[1].toLowerCase()} ${boot[2] === undefined ? '' : `/${boot[2].toLowerCase()}`}`.trim();
    return { category: 'boot', detail, target: '' };
  }

  // --- System registry hives
  const hive = HIVE_DELETE.exec(text) ?? HIVE_DELETE_PROVIDER.exec(text);
  if (hive !== null) return { category: 'registry', detail: `HKLM\\${hive[1].toUpperCase()}`, target: '' };

  // --- System files and permissions
  const roots = systemRoots(env);
  for (const part of statements(text)) {
    if (PERMISSION_TOOL.test(part)) {
      for (const candidate of pathCandidates(part)) {
        if (isUnder(expand(candidate, env), roots)) {
          return { category: 'permissions', detail: candidate, target: candidate };
        }
      }
      continue;
    }

    if (!WRITE_OR_DELETE.test(part)) continue;
    const candidates = pathCandidates(part);
    const inspected = COPY_LIKE.test(part) ? candidates.slice(-1) : candidates;
    for (const candidate of inspected) {
      if (isUnder(expand(candidate, env), roots)) {
        return { category: 'systemfiles', detail: candidate, target: candidate };
      }
    }
  }

  return null;
}

/**
 * True when every statement is a read-only diagnostic. Checked before the
 * critical matcher so `diskpart list disk` and `bcdedit /enum` still work.
 */
export function readOnlyDiagnostic(command) {
  const parts = statements(command);
  if (parts.length === 0) return false;

  const mutating = DISKPART_VERB.test(command) || DISK_CMDLET.test(command);

  for (const part of parts) {
    if (/^diskpart\b/i.test(part)) {
      if (mutating) return false;
      if (!/\blist\s+(?:disk|volume|partition|vdisk)\b/i.test(part)) return false;
      continue;
    }
    if (!READONLY_LINE.some((pattern) => pattern.test(part))) return false;
  }
  return true;
}
