import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const dir = join(tmpdir(), `dsh-redact-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const { rewriteOne, splitFrames, loadPatterns } = await import('../redact.mjs');

const patterns = loadPatterns(null);
const SECRET = 'sk-' + 'b'.repeat(32);

/** Build a file with the same shape as a real session log: header frame, then event frames. */
function makeSession(file, events) {
  mkdirSync(join(file, '..'), { recursive: true });
  const frames = [Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'session-test', cwd: 'D:\\work' }) + '\n')];
  for (const event of events) frames.push(Buffer.from(JSON.stringify(event) + '\n'));
  writeFileSync(file, Buffer.concat(frames.map((frame) => zlib.zstdCompressSync(frame))));
}

const root = join(dir, 'sessions');
const cleanFile = join(root, 'ws', 'session-clean', 'session.v4.jsonl.zstd');
const dirtyFile = join(root, 'ws', 'session-dirty', 'session.v4.jsonl.zstd');

makeSession(cleanFile, [
  { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'ordinary content without secrets' }] } },
  { type: 'assistant/message', seq: 2, data: { usage: { totalTokens: 10 } } },
]);
makeSession(dirtyFile, [
  { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: `my key is ${SECRET}` }] } },
  { type: 'tool/call', seq: 2, data: { name: 'pwsh', arguments: `export KEY=${SECRET}` } },
  { type: 'assistant/message', seq: 3, data: { content: [{ type: 'text', text: 'received' }] } },
]);

const options = { apply: true };

test('clean file is left byte-identical', () => {
  const before = readFileSync(cleanFile);
  const result = rewriteOne(cleanFile, patterns, options);
  assert.equal(result.status, 'clean');
  assert.ok(readFileSync(cleanFile).equals(before));
});

test('dry run reports hits but writes nothing', () => {
  const before = readFileSync(dirtyFile);
  const result = rewriteOne(dirtyFile, patterns, { apply: false });
  assert.equal(result.status, 'would-redact');
  assert.ok(result.hits >= 2);
  assert.ok(readFileSync(dirtyFile).equals(before));
});

test('apply replaces hits, keeps frame count and header bytes', () => {
  const before = readFileSync(dirtyFile);
  const beforeFrames = splitFrames(before);
  const beforeHeader = before.subarray(beforeFrames[0].start, beforeFrames[0].end);

  const result = rewriteOne(dirtyFile, patterns, options);
  assert.equal(result.status, 'redacted');
  assert.ok(result.hits >= 2);

  const after = readFileSync(dirtyFile);
  const afterFrames = splitFrames(after);
  assert.equal(afterFrames.length, beforeFrames.length);
  assert.ok(after.subarray(afterFrames[0].start, afterFrames[0].end).equals(beforeHeader));

  const text = afterFrames.map((frame) => zlib.zstdDecompressSync(after.subarray(frame.start, frame.end)).toString('utf8')).join('');
  assert.ok(!text.includes(SECRET), 'secret must be gone');
  assert.ok(text.includes('[REDACTED]'));
  assert.ok(text.includes('received'), 'non-matching content must survive');
});

test('cleanup', () => {
  rmSync(dir, { recursive: true, force: true });
  assert.equal(existsSync(dir), false);
});
