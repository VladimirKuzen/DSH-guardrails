/**
 * Shared tools for the red-line rules: pattern tables, path normalization,
 * argument walkers and the critical-tier matcher.
 * 红线规则的共享工具：模式表、路径归一化、参数遍历和 critical 层匹配器。
 *
 * Nothing here decides whether a call is allowed — the rules live in rules.js
 * and, later, in lib/rules/*.js. Keeping this file free of rule logic stops it
 * from growing into a second, hidden gate.
 */

import { criticalVerdict } from '../critical.js';

/** Shell verbs that write to or delete from the file system. The `>` branch must not match `=>`, `->` or `>>`. */
const WRITE_VERBS = /\b(set-content|add-content|copy-item|move-item|remove-item|new-item|out-file|rename-item|clear-content|robocopy|cp|mv|rm|ri|del|erase|rd|ren|mkdir|tee|writealltext|writeallbytes|writealllines|appendalltext|writefilesync|createfile)\b|(?<![=<>-])>(?!>)\s*[A-Za-z"$%]/i;

/** Destructive verbs: the default list, extendable from policy. Short aliases must sit in command position so ordinary text is not flagged. */
export const DEFAULT_DESTRUCTIVE = [
  // Delete/move/rename in command position (so "git commit -m 'rm old files'" stays plain text)
  '(?:^|[\\n;&|(){]\\s*)(remove-item|ri|rm|del|erase|rd|rmdir|clear-content|move-item|mv|move|ren|rename|rename-item)(?=\\s|$)',
  '(?:^|[\\n;&|(){]\\s*)robocopy\\b[^\\n]*\\/(mir|mov|purge)',
  // Only real format commands; PowerShell parameters such as Format-Table / -Format are not counted
  '(?:^|[\\n;&|(){]\\s*)format(\\.(?:com|exe))?(?=\\s|$)',
  '\\bformat-volume\\b',
  '\\bdiskpart(?:\\.exe)?\\b',
  '\\bgit\\s+reset\\s+--hard',
  '\\bgit\\s+clean\\s+-[a-z]*f',
  '\\bgit\\s+push\\b[^\\n]*--force',
  '\\breg(?:\\.exe)?\\s+delete\\b',
  '\\bsc(?:\\.exe)?\\s+delete\\b',
  '\\bschtasks(?:\\.exe)?\\s+\\/delete\\b',
  '\\btakeown(?:\\.exe)?\\b',
  '\\bicacls(?:\\.exe)?\\b[^\\n]*\\/(grant|deny|setowner|reset)',
  '\\bwmic(?:\\.exe)?\\b[^\\n]*delete',
  '\\bnet(?:\\.exe)?\\s+user\\b[^\\n]*\\/delete',
  // Registry / service / scheduled task / firewall writes. They are dangerous
  // but recoverable, so they stay at R2 (ask) rather than the critical tier.
  '(?:^|[\\n;&|(){]\\s*)(reg(?:\\.exe)?\\s+(?:add|import|load|restore)|sc(?:\\.exe)?\\s+(?:create|config|failure)|schtasks(?:\\.exe)?\\s+\\/(?:create|change|run)|new-service|set-service)\\b',
  '\\bnetsh\\s+advfirewall\\s+(?:set|reset)\\b',
  '\\b(?:set|new|add)-mppreference\\b',
  '\\b(?:set-itemproperty|new-itemproperty|remove-itemproperty|new-item|remove-item)\\b[^\\n]*hk(?:lm|cu|cr|u|cc):',
  // Disk repair tools: they can rewrite file system or component metadata.
  '(?:^|[\\n;&|(){]\\s*)chkdsk(?:\\.exe)?\\b[^\\n]*\\/(?:f|r)\\b',
  '\\bdism(?:\\.exe)?\\b[^\\n]*\\/(?:remove|add)-',
  // /cleanup-image alone rewrites the component store; scanhealth/checkhealth only read it.
  '\\bdism(?:\\.exe)?\\b[^\\n]*\\/cleanup-image\\b(?![^\\n]*\\/(?:scanhealth|checkhealth))',
  '\\bsfc(?:\\.exe)?\\b[^\\n]*\\/scan(?:now|once)\\b',
];

/** Secret patterns: the default list, extendable from policy. Used for matching only, never for extracting. */
export const DEFAULT_SECRETS = [
  // Fireworks Ark: ark-<uuid>-xxxxx
  'ark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
  // OpenAI / Anthropic style
  'sk-[A-Za-z0-9_-]{20,}',
  // AWS access key
  'AKIA[0-9A-Z]{16}',
  // GitHub token
  'gh[pousr]_[A-Za-z0-9]{20,}',
  // Google API key
  'AIza[0-9A-Za-z_-]{35}',
  // Slack token
  'xox[abp]-[A-Za-z0-9-]{10,}',
  // Generic key=value assignment (the Chinese label is matched on purpose)
  '\\b(api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|密码)\\b\\s*[:=：]\\s*["\']?[A-Za-z0-9_\\-\\.]{12,}',
  // Bearer token
  '\\bbearer\\s+[A-Za-z0-9_\\-\\.]{20,}',
  // Private key block
  '-----BEGIN [A-Z ]*PRIVATE KEY-----',
];

/** Stable ids for each built-in secret pattern; display text lives in i18n. */
const SECRET_LABELS = [
  ['ark-', 'ark'],
  ['sk-', 'openai'],
  ['AKIA', 'aws'],
  ['gh', 'github'],
  ['AIza', 'google'],
  ['xox', 'slack'],
  ['api', 'generic-key'],
  ['bearer', 'bearer'],
  ['-----BEGIN', 'private-key'],
];

/** Tools whose arguments carry a file path. */
export const PATH_TOOLS = new Set(['write', 'edit', 'create_file', 'apply_patch']);

/** Tools whose arguments carry a shell command. */
export const SHELL_TOOLS = new Set(['pwsh', 'bash']);

/** Coerce a value to a string, collapsing non-strings to "". */
export function str(value) {
  return typeof value === 'string' ? value : '';
}

/** Expand ~ / %VAR% / $env:VAR to an absolute path; backslashes and case are normalized for prefix comparison.
 *  A relative path is resolved against `base` (the session cwd) when one is known — without
 *  that, `write` with `"file_path": "lib/x.js"` would slip past every prefix check. */
export function expandPath(input, env, base = '') {
  let p = str(input).trim().replace(/^["']|["']$/g, '');
  if (p === '') return '';
  p = p
    .replace(/^\$env:([A-Za-z_][A-Za-z0-9_]*)/i, (_, name) => str(env[name]) || str(env[`${name.toUpperCase()}`]))
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => str(env[name]) || str(env[`${name.toUpperCase()}`]))
    .replace(/^\$([A-Za-z_][A-Za-z0-9_]*)/, (_, name) => str(env[name]))
    .replace(/^~(?=$|[\\/])/, str(env.USERPROFILE) || str(env.HOME) || '');
  p = p.replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
  const absolute = /^[a-z]:\\/i.test(p) || p.startsWith('\\\\');
  const root = str(base).trim().replace(/\//g, '\\').replace(/\\+$/, '');
  if (!absolute && root !== '' && /^[a-z]:\\/i.test(root)) {
    p = `${root}\\${p.replace(/^\\+/, '')}`;
  }
  return p.toLowerCase();
}

/** First path-like argument of a tool call. */
export function pathOf(args) {
  if (args === null || typeof args !== 'object') return '';
  for (const key of ['file_path', 'filePath', 'path', 'target', 'destination']) {
    if (typeof args[key] === 'string' && args[key] !== '') return args[key];
  }
  return '';
}

/** Collect every string in the arguments for secret scanning. */
export function allStrings(args, out = [], depth = 0) {
  if (depth > 4) return out;
  if (typeof args === 'string') {
    out.push(args);
  } else if (Array.isArray(args)) {
    for (const item of args) allStrings(item, out, depth + 1);
  } else if (args !== null && typeof args === 'object') {
    for (const value of Object.values(args)) allStrings(value, out, depth + 1);
  }
  return out;
}

/** True when the normalized path is the root or sits below one of the roots. */
export function isUnder(path, roots) {
  return roots.some((root) => root !== '' && (path === root || path.startsWith(`${root}\\`)));
}

/** Indices of every path-like `.dsh` / `.agents` mention (absolute paths and $env: forms). */
function homeMentionIndices(command) {
  const indices = [];
  const re = /(^|[\\/'"=\s])\.(dsh|agents)(?=[\\/])/gi;
  let match;
  while ((match = re.exec(command)) !== null) indices.push(match.index + match[1].length);
  return indices;
}

/** How far a write verb may sit from a path mention and still count as "near". Kept finite so a
 *  long script cannot drag two unrelated halves together. */
const NEAR_CHARS = 400;

/**
 * True when a write verb sits within NEAR_CHARS of `index`.
 *
 * Statement boundaries are deliberately NOT respected: the shape a real edit takes is
 * `$p = Join-Path $env:USERPROFILE '.dsh\guardrails\policy.json'; …; Set-Content $p`, where the
 * path and the verb live in different statements, and a statement-limited check misses it — as it
 * missed two real writes on 2026-11-17 (audit shows no record at all, only the sandbox approval).
 */
function nearWrite(command, index) {
  return WRITE_VERBS.test(command.slice(Math.max(0, index - NEAR_CHARS), index + NEAR_CHARS));
}

/** Launch words that put the next token in program position: it is executed, not written. */
const LAUNCHERS = /(?:^|[\s'"])(?:start-process|start|cmd\s*\/c|powershell|pwsh|call)\s*$/i;

/** Start of the whitespace/quote-delimited token that contains `index`. */
function tokenStart(command, index) {
  let at = index;
  while (at > 0 && !/[\s'"`=;|&(){},]/.test(command[at - 1])) at -= 1;
  return at;
}

/**
 * True when the path at `index` is the program being run, not something written to.
 *
 * The ±NEAR_CHARS window made `& '…\.dsh\…\node.exe' script.mjs; Set-Content x` look like a write
 * to node.exe — five false cards between 01:13 and 01:20 on 2026-11-17 (audit shows `kind:
 * 'protected'`, `target: node.exe`). A path in program position is never the target of whatever
 * write verb happens to sit nearby.
 */
export function isProgramMention(command, index) {
  const text = str(command);
  const start = tokenStart(text, index);
  const head = text.slice(Math.max(0, start - 200), start);
  const cut = Math.max(
    head.lastIndexOf(';'),
    head.lastIndexOf('|'),
    head.lastIndexOf('&'),
    head.lastIndexOf('('),
    head.lastIndexOf('{'),
    head.lastIndexOf('\n'),
  );
  const between = head.slice(cut + 1).replace(/^[\s@]+/, '').replace(/[\s'"]+$/, '');
  if (between === '') return true;
  return LAUNCHERS.test(between);
}

/** R1 only fires when a write verb sits near a home path mention (see `nearWrite`). */
export function mentionsHomeNearWrite(command) {
  for (const index of homeMentionIndices(command)) {
    if (isProgramMention(command, index)) continue;
    if (nearWrite(command, index)) return true;
  }
  return false;
}

/** After a root mention, the path must end or hit a separator — otherwise `dsh-guardrails2` would match `dsh-guardrails`. */
const ROOT_TAIL = /^(?:$|[\\/"'\s);,|>])/;

/**
 * Same shape as mentionsHomeNearWrite, for arbitrary normalized roots.
 * 自保护用：任意受保护根（已由 expandPath 归一为小写、反斜杠）出现在命令里，且 400 字符内
 * 有写动词就命中——不要求同一语句，因为 `$p = '…'; …; Set-Content $p` 这种变量转手是常态。
 */
export function mentionsPathNearWrite(command, roots) {
  const lower = str(command).toLowerCase();
  for (const root of roots) {
    if (root === '') continue;
    let at = lower.indexOf(root);
    while (at >= 0) {
      if (ROOT_TAIL.test(lower.slice(at + root.length))
        && !isProgramMention(lower, at)
        && nearWrite(lower, at)) return true;
      at = lower.indexOf(root, at + 1);
    }
  }
  return false;
}

/** Map a matched secret to its stable label id. */
export function labelFor(matchedText) {
  const lower = matchedText.toLowerCase();
  for (const [prefix, id] of SECRET_LABELS) {
    if (lower.startsWith(prefix.toLowerCase())) return id;
  }
  return 'generic-key';
}

/** Model-facing names for the critical categories; the card copy lives in i18n. */
export const CRITICAL_TEXT = {
  disk: 'disk-level operation',
  boot: 'boot configuration change',
  systemfiles: 'delete/overwrite inside a system directory',
  permissions: 'permission change on a system directory',
  registry: 'system registry hive deletion',
  custom: 'critical operation',
};

/** Match the critical tier: built-in matcher first, then policy-supplied patterns. */
export function findCritical(command, env, patterns) {
  const builtin = criticalVerdict(command, env);
  if (builtin !== null) return builtin;

  for (const source of patterns) {
    let re;
    try {
      re = new RegExp(source, 'i');
    } catch {
      continue;
    }
    const hit = re.exec(command);
    if (hit !== null) return { category: 'custom', detail: (hit[1] ?? hit[0]).trim(), target: '' };
  }
  return null;
}

/** English reason for a critical hit; the model reads this, so it stays plain text. */
export function criticalReason(critical, mode) {
  const what = CRITICAL_TEXT[critical.category] ?? 'critical operation';
  const name = critical.detail === '' ? '' : ` (${critical.detail})`;
  if (mode === 'deny') {
    return `Guardrails R2 (critical): ${what}${name} was refused. This can make Windows unbootable or erase data, and the target cannot be verified from text. Take a backup and run it yourself in a terminal if you really mean it.`;
  }
  return `Guardrails R2 (critical): ${what}${name} requires explicit approval. This can make Windows unbootable or erase data; verify the target before allowing it.`;
}
