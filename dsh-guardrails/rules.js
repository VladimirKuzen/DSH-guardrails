/**
 * 红线判定 —— 纯函数，不碰文件系统、不发事件，方便单测。
 *
 * 三条红线：
 *   R1 不碰 DSH 自身目录（~/.dsh、~/.agents、插件与 profile）
 *   R2 破坏性操作先 dry-run
 *   R3 密钥只进配置文件，不进对话
 *
 * Returns null to allow the call; otherwise returns { rule, mode, reason, label }.
 * Presentation copy (displayReason) is built by the host in index.js.
 */

/** 会在文件系统上产生写入或删除的 shell 动词。`>` 要求不是 `=>` / `->` / `>>`。 */
const WRITE_VERBS = /\b(set-content|add-content|copy-item|move-item|remove-item|new-item|out-file|rename-item|clear-content|robocopy|cp|mv|rm|ri|del|erase|rd|ren|mkdir|tee)\b|(?<![=<>-])>(?!>)\s*[A-Za-z"$%]/i;

/** 破坏性动词：默认清单，policy 里可以加。短别名要求出现在命令位置，避免误伤普通文本。 */
export const DEFAULT_DESTRUCTIVE = [
  // 命令位置上的删除/移动/改名（避免把 "git commit -m 'rm old files'" 这类文本当成命令）
  '(?:^|[\\n;&|(){]\\s*)(remove-item|ri|rm|del|erase|rd|rmdir|clear-content|move-item|mv|move|ren|rename|rename-item)(?=\\s|$)',
  '(?:^|[\\n;&|(){]\\s*)robocopy\\b[^\\n]*\\/(mir|mov|purge)',
  // 只认真正的 format 命令；Format-Table / -Format 这类 PowerShell 参数不算
  '(?:^|[\\n;&|(){]\\s*)format(\\.com)?(?=\\s|$)',
  '\\bformat-volume\\b',
  '\\bdiskpart\\b',
  '\\bgit\\s+reset\\s+--hard',
  '\\bgit\\s+clean\\s+-[a-z]*f',
  '\\bgit\\s+push\\b[^\\n]*--force',
  '\\breg\\s+delete\\b',
  '\\bsc\\s+delete\\b',
  '\\bschtasks\\s+\\/delete\\b',
  '\\btakeown\\b',
  '\\bicacls\\b[^\\n]*\\/(grant|deny|setowner|reset)',
  '\\bwmic\\b[^\\n]*delete',
  '\\bnet\\s+user\\b[^\\n]*\\/delete',
];

/** 密钥特征：默认清单，policy 里可以加。只用于命中，不用于提取。 */
export const DEFAULT_SECRETS = [
  // 火山方舟 Ark：ark-<uuid>-xxxxx
  'ark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
  // OpenAI / Anthropic 风格
  'sk-[A-Za-z0-9_-]{20,}',
  // AWS Access Key
  'AKIA[0-9A-Z]{16}',
  // GitHub token
  'gh[pousr]_[A-Za-z0-9]{20,}',
  // Google API key
  'AIza[0-9A-Za-z_-]{35}',
  // Slack token
  'xox[abp]-[A-Za-z0-9-]{10,}',
  // 通用 key=value 赋值
  '\\b(api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|密码)\\b\\s*[:=：]\\s*["\']?[A-Za-z0-9_\\-\\.]{12,}',
  // Bearer
  '\\bbearer\\s+[A-Za-z0-9_\\-\\.]{20,}',
  // 私钥块
  '-----BEGIN [A-Z ]*PRIVATE KEY-----',
];

/** 每个内置密钥模式的短标签，只用于提示，绝不带出原文。 */
const SECRET_LABELS = [
  ['ark-', '火山方舟 Ark API Key'],
  ['sk-', 'OpenAI/Anthropic 风格密钥'],
  ['AKIA', 'AWS Access Key'],
  ['gh', 'GitHub Token'],
  ['AIza', 'Google API Key'],
  ['xox', 'Slack Token'],
  ['api', '疑似 key/密码赋值'],
  ['bearer', 'Bearer Token'],
  ['-----BEGIN', '私钥'],
];

const PATH_TOOLS = new Set(['write', 'edit', 'create_file', 'apply_patch']);
const SHELL_TOOLS = new Set(['pwsh', 'bash']);

function str(value) {
  return typeof value === 'string' ? value : '';
}

/** 把 ~ / %VAR% / $env:VAR 展开成绝对路径，统一反斜杠与小写，便于前缀比较。 */
export function expandPath(input, env) {
  let p = str(input).trim().replace(/^["']|["']$/g, '');
  if (p === '') return '';
  p = p
    .replace(/^\$env:([A-Za-z_][A-Za-z0-9_]*)/i, (_, name) => str(env[name]) || str(env[`${name.toUpperCase()}`]))
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => str(env[name]) || str(env[`${name.toUpperCase()}`]))
    .replace(/^\$([A-Za-z_][A-Za-z0-9_]*)/, (_, name) => str(env[name]))
    .replace(/^~(?=$|[\\/])/, str(env.USERPROFILE) || str(env.HOME) || '');
  p = p.replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
  return p.toLowerCase();
}

/** 取工具参数里表示路径的字段。 */
function pathOf(args) {
  if (args === null || typeof args !== 'object') return '';
  for (const key of ['file_path', 'filePath', 'path', 'target', 'destination']) {
    if (typeof args[key] === 'string' && args[key] !== '') return args[key];
  }
  return '';
}

/** 收集参数里所有字符串，供密钥扫描。 */
function allStrings(args, out = [], depth = 0) {
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

function isUnder(path, roots) {
  return roots.some((root) => root !== '' && (path === root || path.startsWith(`${root}\\`)));
}

/** 找出命令里所有像路径的 `.dsh` / `.agents` 片段位置（兼容绝对路径与 $env: 写法）。 */
function homeMentionIndices(command) {
  const indices = [];
  const re = /(^|[\\/'"=\s])\.(dsh|agents)(?=[\\/])/gi;
  let match;
  while ((match = re.exec(command)) !== null) indices.push(match.index + match[1].length);
  return indices;
}

/** 只有写动词与 home 路径落在同一条语句（同一行、同一段管道）里，才算 R1。 */
function mentionsHomeNearWrite(command) {
  for (const index of homeMentionIndices(command)) {
    const start = Math.max(
      command.lastIndexOf('\n', index),
      command.lastIndexOf(';', index),
      command.lastIndexOf('|', index),
      command.lastIndexOf('&', index),
    );
    let end = command.length;
    for (const ch of ['\n', ';', '|', '&']) {
      const at = command.indexOf(ch, index);
      if (at >= 0) end = Math.min(end, at);
    }
    const segment = command.slice(start + 1, end);
    if (segment.length <= 400 && WRITE_VERBS.test(segment)) return true;
  }
  return false;
}

function labelFor(matchedText) {
  const lower = matchedText.toLowerCase();
  for (const [prefix, label] of SECRET_LABELS) {
    if (lower.startsWith(prefix.toLowerCase())) return label;
  }
  return '疑似密钥';
}

/**
 * 判定一次工具调用。
 * @param {object} policy 解析后的策略
 * @param {{name: string, args: unknown}} call 工具调用
 * @param {object} env 形如 { USERPROFILE, DSH_HOME, AGENTS_HOME }
 * @returns {null | {rule: string, mode: string, reason: string, label?: string}}
 */
export function evaluate(policy, call, env) {
  if (policy === null || typeof policy !== 'object' || policy.enabled === false) return null;
  const rules = policy.rules ?? {};
  const name = str(call?.name);
  const args = call?.arguments ?? call?.args ?? {};
  const strings = allStrings(args);

  // ---- R3 密钥（最严重，先判）
  const secretRule = rules.secrets ?? {};
  if (secretRule.mode !== 'off') {
    const patterns = [...DEFAULT_SECRETS, ...(secretRule.patterns ?? [])];
    for (const source of patterns) {
      let re;
      try {
        re = new RegExp(source, 'i');
      } catch {
        continue;
      }
      for (const text of strings) {
        const hit = re.exec(text);
        if (hit) {
          const label = labelFor(hit[0]);
          return {
            rule: 'R3',
            mode: secretRule.mode === 'deny' ? 'deny' : 'ask',
            label,
            reason: `Guardrails R3: tool "${name}" appears to carry a secret (${label}); secrets must live in config files or environment variables, not in tool arguments or conversation.`,
          };
        }
      }
    }
  }

  // ---- R1 DSH 自身目录
  const homeRule = rules.protectDshHome ?? {};
  if (homeRule.mode !== 'off') {
    const roots = (homeRule.roots ?? ['~/.dsh', '~/.agents']).map((root) => expandPath(root, env)).filter(Boolean);
    const alwaysAsk = new Set(homeRule.alwaysAskTools ?? ['plugin_manager']);
    const mode = homeRule.mode === 'deny' ? 'deny' : 'ask';

    if (alwaysAsk.has(name)) {
      return {
        rule: 'R1',
        mode,
        reason: `Guardrails R1: tool "${name}" changes DSH's own profile/plugins under the protected home; it requires explicit approval.`,
      };
    }

    if (PATH_TOOLS.has(name)) {
      const target = expandPath(pathOf(args), env);
      if (isUnder(target, roots)) {
        return {
          rule: 'R1',
          mode,
          reason: `Guardrails R1: tool "${name}" writes inside DSH's protected home (${target}).`,
        };
      }
    }

    if (SHELL_TOOLS.has(name)) {
      const command = str(args.command ?? args.cmd ?? args.script);
      if (mentionsHomeNearWrite(command)) {
        return {
          rule: 'R1',
          mode,
          reason: `Guardrails R1: shell command both references DSH's protected home and writes/moves/deletes files.`,
        };
      }
    }
  }

  // ---- R2 破坏性操作
  const destructiveRule = rules.destructive ?? {};
  if (destructiveRule.mode !== 'off' && SHELL_TOOLS.has(name)) {
    const command = str(args.command ?? args.cmd ?? args.script);
    const patterns = [...DEFAULT_DESTRUCTIVE, ...(destructiveRule.patterns ?? [])];
    for (const source of patterns) {
      let re;
      try {
        re = new RegExp(source, 'i');
      } catch {
        continue;
      }
      const hit = re.exec(command);
      if (hit) {
        const shown = (hit[1] ?? hit[0]).trim();
        return {
          rule: 'R2',
          mode: destructiveRule.mode === 'deny' ? 'deny' : 'ask',
          reason: `Guardrails R2: destructive shell operation "${shown}" requires explicit approval.`,
        };
      }
    }
  }

  return null;
}
