#!/usr/bin/env node
/**
 * audit-report — read the v2 event stream without loading DSH.
 * audit-report —— 离线读取 v2 审计事件流（不启动 DSH）。
 *
 * Usage / 用法:
 *   node tools/audit-report.mjs                    last 20 events
 *   node tools/audit-report.mjs --stats            counts by event/rule/outcome
 *   node tools/audit-report.mjs --verify           check the hash chain
 *   node tools/audit-report.mjs --since 2026-11-15 --rule R2 --event requested
 *   node tools/audit-report.mjs --show-payload     print the stored payload
 *
 * Default root: <DSH_HOME>/guardrails/audit/v2. Exit code 1 means the chain
 * verifier found a broken or edited record.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { verifyChain } from '../lib/audit/v2.js';

function defaultRoot() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(home, 'guardrails', 'audit', 'v2');
}

function parseArgs(argv) {
  const options = {
    dir: defaultRoot(),
    stats: false,
    verify: false,
    since: null,
    rule: null,
    event: null,
    showPayload: false,
    json: false,
    limit: 20,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--dir': options.dir = argv[++index]; break;
      case '--stats': options.stats = true; break;
      case '--verify': options.verify = true; break;
      case '--since': options.since = argv[++index]; break;
      case '--rule': options.rule = argv[++index]; break;
      case '--event': options.event = argv[++index]; break;
      case '--show-payload': options.showPayload = true; break;
      case '--json': options.json = true; break;
      case '--limit': options.limit = Number(argv[++index]) || 20; break;
      case '--help':
      case '-h':
        process.stdout.write('node tools/audit-report.mjs [--dir DIR] [--stats] [--verify] [--since DAY] [--rule R1] [--event requested] [--show-payload] [--json] [--limit N]\n');
        process.exit(0);
        break;
      default:
        process.stderr.write(`unknown option: ${arg}\n`);
        process.exit(2);
    }
  }
  return options;
}

function loadRecords(dir) {
  if (!existsSync(dir)) return { records: [], broken: [] };
  const files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  const records = [];
  const broken = [];
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8');
    for (const [lineNo, line] of text.split('\n').entries()) {
      if (line.trim() === '') continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        broken.push(`${name}:${lineNo + 1}`);
      }
    }
  }
  return { records, broken };
}

function matches(record, options) {
  if (options.since !== null && String(record.ts ?? '') < options.since) return false;
  if (options.rule !== null && record.rule !== options.rule) return false;
  if (options.event !== null && record.event !== options.event) return false;
  return true;
}

function summaryLine(record) {
  const bits = [
    String(record.ts ?? '').replace('T', ' ').slice(0, 19),
    String(record.event ?? '?').padEnd(9),
    String(record.rule ?? '-').padEnd(3),
    String(record.mode ?? '-').padEnd(5),
    String(record.tool ?? '-').padEnd(9),
    record.severity === undefined ? '' : `[${record.severity}]`,
    record.outcome === undefined ? '' : `outcome=${record.outcome}`,
    record.target === null || record.target === undefined ? '' : `target=${record.target}`,
  ];
  return bits.filter((part) => part !== '').join(' ');
}

function stats(records) {
  const count = (key) => {
    const map = new Map();
    for (const record of records) {
      const value = String(record[key] ?? '-');
      map.set(value, (map.get(value) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  };
  const lines = [`records: ${records.length}`];
  for (const [label, key] of [['event', 'event'], ['rule', 'rule'], ['mode', 'mode'], ['outcome', 'outcome'], ['tool', 'tool']]) {
    const rows = count(key);
    if (rows.length === 0) continue;
    lines.push(`${label}:`);
    for (const [value, n] of rows) lines.push(`  ${value.padEnd(12)} ${n}`);
  }
  return lines.join('\n');
}

function payloadText(dir, record) {
  if (typeof record.payloadRef !== 'string' || record.payloadRef === '') return null;
  const file = join(dir, record.payloadRef);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  return text.length > 2_000 ? `${text.slice(0, 2_000)}\n… (${record.payloadBytes} bytes total)` : text;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { records, broken } = loadRecords(options.dir);
  const selected = records.filter((record) => matches(record, options));

  if (broken.length > 0) {
    process.stderr.write(`warning: ${broken.length} unparsable line(s): ${broken.slice(0, 5).join(', ')}\n`);
  }

  if (options.verify) {
    const result = records.length === 0 ? { ok: true, index: 0 } : verifyChain(records);
    if (!result.ok) {
      process.stderr.write(`chain broken at record ${result.index} (${result.brokenAt ?? '?'}): ${result.reason}\n`);
      process.exit(1);
    }
    process.stdout.write(`chain ok: ${records.length} record(s) verified\n`);
    return;
  }

  if (options.stats) {
    process.stdout.write(`${stats(selected)}\n`);
    return;
  }

  const shown = selected.slice(-options.limit);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
    return;
  }
  for (const record of shown) {
    process.stdout.write(`${summaryLine(record)}\n`);
    if (options.showPayload) {
      const text = payloadText(options.dir, record);
      if (text !== null) process.stdout.write(`  payload:\n${text.replace(/^/gm, '    ')}\n`);
    }
  }
  if (shown.length === 0) process.stdout.write('no matching records\n');
}

main();
