/**
 * 规则自检：把历史会话里真实出现过的工具调用，重新过一遍当前规则，
 * 打印"哪条规则命中、命中文本是什么"。用来抓误报，改完规则再跑一次对比。
 *
 * 用法：
 *   node check-rules.mjs                      # 扫全部会话
 *   node check-rules.mjs --session <id前缀>    # 只看某个会话
 *   node check-rules.mjs --limit 50
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { evaluate } from '../dsh-guardrails/rules.js';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function parseArgs(argv) {
  const out = { session: null, limit: 200, root: join(homedir(), '.dsh', 'sessions') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--session') out.session = argv[++i];
    else if (argv[i] === '--limit') out.limit = Number(argv[++i]);
    else if (argv[i] === '--root') out.root = argv[++i];
  }
  return out;
}

function frames(buf) {
  const parts = [];
  let start = 0;
  let cursor = 4;
  while (start < buf.length) {
    let end = buf.length;
    for (let pos = cursor; ;) {
      const idx = buf.indexOf(MAGIC, pos);
      if (idx < 0) break;
      try {
        zlib.zstdDecompressSync(buf.subarray(start, idx));
        end = idx;
        break;
      } catch {
        pos = idx + 1;
      }
    }
    parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
    if (end >= buf.length) break;
    start = end;
    cursor = start + 4;
  }
  return parts;
}

function listSessionFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

const env = {
  USERPROFILE: process.env.USERPROFILE ?? homedir(),
  HOME: homedir(),
  DSH_HOME: join(homedir(), '.dsh'),
  AGENTS_HOME: join(homedir(), '.agents'),
};

const policy = { enabled: true };

function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = listSessionFiles(options.root).filter((f) => options.session === null || f.includes(options.session));

  const rows = [];
  for (const file of files) {
    for (const text of frames(readFileSync(file))) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type !== 'tool/call') continue;
        const data = event.data ?? {};
        let args;
        try {
          args = JSON.parse(data.arguments);
        } catch {
          args = {};
        }
        const verdict = evaluate(policy, { name: data.name, arguments: args }, env);
        if (verdict !== null) {
          rows.push({
            time: event.time,
            tool: data.name,
            rule: verdict.rule,
            reason: verdict.reason,
            sample: typeof args.command === 'string' ? args.command.replace(/\s+/g, ' ').slice(0, 110) : (args.file_path ?? ''),
          });
        }
      }
    }
  }

  const recent = rows.slice(-options.limit);
  const byRule = {};
  for (const row of rows) byRule[row.rule] = (byRule[row.rule] ?? 0) + 1;

  console.log(`共 ${rows.length} 次调用会命中：${JSON.stringify(byRule)}`);
  console.log('');
  for (const row of recent) {
    console.log(`${row.rule}  ${row.tool.padEnd(6)} ${String(row.sample)}`);
    console.log(`     ↳ ${row.reason.slice(0, 130)}`);
  }
}

main();
