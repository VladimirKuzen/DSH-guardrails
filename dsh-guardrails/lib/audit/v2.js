/**
 * audit/v2 — the append-only event stream behind P2.
 * audit/v2 —— P2 审计事件流：按日 JSONL、原文 payload、哈希链。
 *
 * Each operation is a small chain of records sharing one `id`: `requested`,
 * `delivered`, `outcome`, `executed`, plus `allowed` for quiet-workspace
 * releases. Records are linked by `prevHash` so a truncated or edited line is
 * detectable without a signature.
 * 一次操作由共享同一个 `id` 的若干记录组成：`requested`、`delivered`、`outcome`、
 * `executed`，以及工作区静默放行时的 `allowed`。记录用 `prevHash` 串成哈希链，
 * 任何截断或篡改都能被发现（不含签名）。
 *
 * File layout under one root:
 *   <root>/<YYYY-MM-DD>.jsonl
 *   <root>/payload/<YYYY-MM-DD>/<id>.txt
 *   <root>/chain.json  ({ date, lastHash, count })
 */

import { appendFileSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const GENESIS = 'genesis';

/** Stable JSON: object keys sorted, no whitespace. Used for the hash input. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * Truncate by Unicode code points, never by UTF-8 bytes: a byte cut splits
 * multi-byte characters and produced the `鈥?` tail in v1.
 */
export function truncateCodePoints(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return { text, truncated: false };
  return { text: chars.slice(0, max).join(''), truncated: true };
}

/** Collapse control characters so one record always stays on one line. */
export function escapeControl(text) {
  return text.replace(/[\u0000-\u001f\u007f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** sha256(prevHash + "\n" + canonicalJson(recordWithoutHash)). */
export function recordHash(prevHash, record) {
  return createHash('sha256').update(prevHash).update('\n').update(canonicalJson(record)).digest('hex');
}

/** Local calendar day, matching what a human sees in the file name. */
export function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Verify one parsed stream in file order.
 * @returns {{ ok: boolean, index: number, reason?: string, brokenAt?: string }}
 */
export function verifyChain(records, { startHash = GENESIS } = {}) {
  let prevHash = startHash;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === null || typeof record !== 'object') {
      return { ok: false, index, reason: 'record is not an object', brokenAt: record?.id };
    }
    if (record.prevHash !== prevHash) {
      return { ok: false, index, reason: 'prevHash does not match the previous record', brokenAt: record.id };
    }
    const { hash: _hash, ...body } = record;
    const expected = recordHash(record.prevHash, body);
    if (record.hash !== expected) {
      return { ok: false, index, reason: 'hash does not match the record content', brokenAt: record.id };
    }
    prevHash = record.hash;
  }
  return { ok: true, index: records.length };
}

/** Trim a half-written trailing line left by a crash before appending again. */
function repairTail(file) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size === 0) return;
  const chunk = Math.min(size, 8192);
  const buffer = Buffer.alloc(chunk);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, chunk, size - chunk);
  } finally {
    closeSync(fd);
  }
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === chunk - 1) return;
  const keep = lastNewline === -1 ? 0 : size - chunk + lastNewline + 1;
  const writeFd = openSync(file, 'r+');
  try {
    ftruncateSync(writeFd, keep);
  } finally {
    closeSync(writeFd);
  }
}

/**
 * One writer per audit root. Safe to construct more than once in a process:
 * the chain state is re-read from `chain.json` on first append.
 */
export class AuditLog {
  constructor({ dir, now = () => new Date(), maxPayloadBytes = 64 * 1024 } = {}) {
    if (typeof dir !== 'string' || dir === '') throw new TypeError('AuditLog needs a dir');
    this.dir = dir;
    this.now = now;
    this.maxPayloadBytes = maxPayloadBytes;
    this.state = null;
  }

  /** Append one record; returns the stored record (with `prevHash` and `hash`). */
  append(input) {
    const date = this.now();
    const day = dayKey(date);
    const id = typeof input.id === 'string' && input.id !== '' ? input.id : randomUUID();

    mkdirSync(this.dir, { recursive: true });
    const payload = this.writePayload(input, day, id);
    this.state ??= this.readChain();

    const prevHash = this.state.lastHash ?? GENESIS;
    const record = {
      v: 2,
      id,
      event: input.event,
      ts: date.toISOString(),
      sessionId: input.sessionId ?? null,
      cwd: input.cwd ?? null,
      tool: input.tool ?? null,
      callId: input.callId ?? null,
      rule: input.rule ?? null,
      mode: input.mode ?? null,
      ...(input.severity === undefined ? {} : { severity: input.severity }),
      target: input.target ?? null,
      facts: input.facts ?? null,
      displayReason: input.displayReason ?? null,
      localeAtDecision: input.localeAtDecision ?? null,
      payloadRef: payload.ref,
      payloadSha256: payload.sha256,
      payloadBytes: payload.bytes,
      payloadTruncated: payload.truncated,
      ...(input.delivered === undefined ? {} : { delivered: input.delivered }),
      ...(input.approvalRequestId === undefined ? {} : { approvalRequestId: input.approvalRequestId }),
      ...(input.deliveredAt === undefined ? {} : { deliveredAt: input.deliveredAt }),
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.isError === undefined ? {} : { isError: input.isError }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.quiet === undefined ? {} : { quiet: input.quiet }),
      prevHash,
    };
    record.hash = recordHash(prevHash, record);

    const file = join(this.dir, `${day}.jsonl`);
    repairTail(file);
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    this.state = { date: day, lastHash: record.hash, count: this.state.count + 1 };
    this.writeChain();
    return record;
  }

  writePayload(input, day, id) {
    const text = typeof input.payload === 'string' ? input.payload : '';
    if (text === '') return { ref: null, sha256: null, bytes: null, truncated: false };
    const raw = Buffer.from(text, 'utf8');
    const truncated = raw.length > this.maxPayloadBytes;
    const base = {
      sha256: createHash('sha256').update(raw).digest('hex'),
      bytes: raw.length,
      truncated,
    };
    // Secrets are provable by hash and never stored: the record still answers
    // "what exactly ran" without keeping the credential on disk.
    if (input.secret === true) return { ref: null, ...base };
    const dir = join(this.dir, 'payload', day);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.txt`), truncated ? raw.subarray(0, this.maxPayloadBytes) : raw);
    return { ref: `payload/${day}/${id}.txt`, ...base };
  }

  readChain() {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir, 'chain.json'), 'utf8'));
      if (typeof parsed?.lastHash === 'string' && parsed.lastHash !== '') {
        return { date: parsed.date ?? null, lastHash: parsed.lastHash, count: Number(parsed.count) || 0 };
      }
    } catch {
      // Missing or corrupt chain state: start a fresh chain at this file.
    }
    return { date: null, lastHash: GENESIS, count: 0 };
  }

  writeChain() {
    const target = join(this.dir, 'chain.json');
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state)}\n`, 'utf8');
    renameSync(tmp, target);
  }
}
