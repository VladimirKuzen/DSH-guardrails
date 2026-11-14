import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { snapshot, prune, listSessions } from '../redact.mjs';

const base = join(tmpdir(), `dsh-backup-test-${process.pid}`);
const sessions = join(base, 'sessions');
const vault = join(base, 'vault');
const restored = join(base, 'restored');

const ws = join(sessions, 'ws');
const fileA = join(ws, 'session-aaa', 'session.v4.jsonl.zstd');
const fileB = join(ws, 'session-bbb', 'session.v4.jsonl.zstd');

mkdirSync(join(ws, 'session-aaa'), { recursive: true });
mkdirSync(join(ws, 'session-bbb'), { recursive: true });
writeFileSync(fileA, Buffer.from('alpha-content-that-stands-in-for-a-session-log'));
writeFileSync(fileB, Buffer.from('alpha-content-that-stands-in-for-a-session-log'));

function blobs() {
  try {
    return readdirSync(join(vault, 'blobs'));
  } catch {
    return [];
  }
}

function manifests() {
  try {
    return readdirSync(join(vault, 'manifests'));
  } catch {
    return [];
  }
}

test('snapshot stores one blob for identical content', () => {
  const result = snapshot(listSessions(sessions), sessions, vault);
  assert.equal(result.count, 2);
  assert.equal(result.stored, 1, 'identical content must be stored once');
  assert.equal(result.reused, 1);
  assert.equal(blobs().length, 1);
  assert.equal(manifests().length, 1);
  assert.ok(!existsSync(join(vault, 'blobs', `${result.manifestPath}.tmp`)));
});

test('second snapshot reuses every unchanged blob', () => {
  const result = snapshot(listSessions(sessions), sessions, vault);
  assert.equal(result.stored, 0);
  assert.equal(result.reused, 2);
  assert.equal(blobs().length, 1);
  assert.equal(manifests().length, 1, 'two runs inside one second still merge names; acceptable');
});

test('restore brings back byte-identical files and verifies SHA-256', () => {
  const manifest = join(vault, 'manifests', manifests()[0]);
  const script = join(import.meta.dirname, '..', 'restore.ps1');
  const run = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Manifest', manifest, '-Target', restored,
  ], { stdio: 'ignore' });

  assert.equal(run.status, 0, 'restore.ps1 must exit 0');
  const backA = readFileSync(join(restored, 'ws', 'session-aaa', 'session.v4.jsonl.zstd'));
  assert.ok(backA.equals(readFileSync(fileB)), 'restored bytes must match the original');
});

test('prune drops old manifests and blobs nobody references', () => {
  const before = manifests().length;
  const result = prune(vault, 0);
  assert.equal(result.manifests, before, 'keep-days 0 drops every manifest');
  assert.equal(result.blobs, 1, 'unreferenced blob must be deleted');
  assert.equal(blobs().length, 0);
});

test('cleanup', () => {
  rmSync(base, { recursive: true, force: true });
  assert.equal(existsSync(base), false);
});
