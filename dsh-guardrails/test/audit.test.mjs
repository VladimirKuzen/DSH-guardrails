import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuditLog,
  canonicalJson,
  dayKey,
  escapeControl,
  recordHash,
  truncateCodePoints,
  verifyChain,
} from '../lib/audit/v2.js';

const root = mkdtempSync(join(tmpdir(), 'audit-v2-'));
const at = new Date('2026-11-15T09:30:00.000Z');
const now = () => at;

function records(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

test('canonicalJson sorts keys and omits whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  assert.equal(canonicalJson('x'), '"x"');
  assert.equal(canonicalJson(null), 'null');
});

test('canonicalJson mirrors JSON.stringify for undefined values', () => {
  // A record built with `facts: { severity: undefined }` is written by
  // JSON.stringify without that key; the hash must be computed the same way.
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson({ nested: { x: undefined, y: 2 } }), '{"nested":{"y":2}}');
  assert.equal(canonicalJson([undefined, 1]), '[null,1]');
});

test('truncateCodePoints never splits a multi-byte character', () => {
  const result = truncateCodePoints('😀😀😀中文', 3);
  assert.equal(result.text, '😀😀😀');
  assert.equal(result.truncated, true);
  assert.equal(truncateCodePoints('abc', 5).truncated, false);
  // The old byte-truncation produced a broken tail like "鈥?"; the tail here must
  // always be a whole code point.
  assert.equal([...truncateCodePoints('a—b', 2).text].length, 2);
});

test('escapeControl keeps one record on one line', () => {
  assert.equal(escapeControl('a\nb\r\tc'), 'a\\u000ab\\u000d\\u0009c');
});

test('recordHash covers the record content and the previous hash', () => {
  const record = { v: 2, id: 'x', event: 'requested' };
  assert.notEqual(recordHash('genesis', record), recordHash('other', record));
  const changed = { ...record, event: 'outcome' };
  assert.notEqual(recordHash('genesis', record), recordHash('genesis', changed));
});

test('append writes a record, its payload and a verifiable chain', () => {
  const dir = join(root, 'basic');
  const log = new AuditLog({ dir, now });
  log.append({ id: 'op-1', event: 'requested', callId: 'c1', rule: 'R2', mode: 'ask', target: 'Remove-Item x', payload: 'Remove-Item x' });
  log.append({ id: 'op-1', event: 'outcome', callId: 'c1', rule: 'R2', mode: 'ask', outcome: 'allowed-once' });

  const lines = records(dir);
  assert.equal(lines.length, 2);
  assert.equal(dayKey(at), '2026-11-15');
  assert.equal(lines[0].payloadRef, 'payload/2026-11-15/op-1.txt');
  assert.equal(readFileSync(join(dir, lines[0].payloadRef), 'utf8'), 'Remove-Item x');
  assert.match(lines[0].payloadSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(verifyChain(lines), { ok: true, index: 2 });
  const chain = JSON.parse(readFileSync(join(dir, 'chain.json'), 'utf8'));
  assert.equal(chain.lastHash, lines[1].hash);
});

test('payloads over the cap are truncated on disk but hashed in full', () => {
  const dir = join(root, 'truncated');
  const log = new AuditLog({ dir, now, maxPayloadBytes: 4 });
  const record = log.append({ id: 'op-2', event: 'requested', payload: 'abcdefgh' });
  assert.equal(record.payloadTruncated, true);
  assert.equal(record.payloadBytes, 8);
  assert.equal(readFileSync(join(dir, record.payloadRef), 'utf8'), 'abcd');
});

test('secret payloads write no file and no hash', () => {
  const dir = join(root, 'secret');
  const log = new AuditLog({ dir, now });
  const record = log.append({ id: 'op-3', event: 'requested', payload: 'sk-test-secret', secret: true });
  assert.equal(record.payloadRef, null);
  assert.equal(record.payloadBytes, 14);
  // A hash of a low-entropy secret is a dictionary oracle, so there is none.
  assert.equal(record.payloadSha256, null);
  assert.equal(existsSync(join(dir, 'payload')), false);
});

test('a half-written trailing line is repaired before the next append', () => {
  const dir = join(root, 'repair');
  const log = new AuditLog({ dir, now });
  log.append({ id: 'op-4', event: 'requested', payload: 'a' });
  const file = join(dir, '2026-11-15.jsonl');
  appendFileSync(file, '{"v":2,"id":"torn"', 'utf8');
  log.append({ id: 'op-4', event: 'outcome', outcome: 'allowed-once' });

  const lines = records(dir);
  assert.equal(lines.length, 2);
  assert.deepEqual(verifyChain(lines), { ok: true, index: 2 });
});

test('a record with undefined fields still verifies after a JSON round-trip', () => {
  const dir = join(root, 'undefined-fields');
  const log = new AuditLog({ dir, now });
  log.append({
    id: 'op-6',
    event: 'requested',
    rule: 'R2',
    mode: 'ask',
    facts: { kind: 'delete', severity: undefined, criticalCategory: '' },
    payload: 'Remove-Item x',
  });
  // Re-parse exactly what is on disk: the undefined key is gone, and the hash
  // must still match (this is the bug the first live run exposed).
  const lines = records(dir);
  assert.equal('severity' in lines[0].facts, false);
  assert.deepEqual(verifyChain(lines), { ok: true, index: 1 });
});

test('verifyChain reports a tampered record', () => {
  const dir = join(root, 'tampered');
  const log = new AuditLog({ dir, now });
  log.append({ id: 'op-5', event: 'requested', payload: 'a' });
  log.append({ id: 'op-5', event: 'outcome', outcome: 'rejected' });
  const lines = records(dir);
  lines[0].target = 'edited afterwards';
  const result = verifyChain(lines);
  assert.equal(result.ok, false);
  assert.equal(result.index, 0);
  assert.match(result.reason, /hash/);
});
