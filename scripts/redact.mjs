/**
 * End-of-day redaction with an encrypted, restorable snapshot.
 *
 * What it does, in order:
 *   1. Snapshot: every session log is hashed; unchanged content is stored once
 *      as an encrypted blob, unchanged blobs are reused (content addressed).
 *   2. Redact: only files that actually contain a secret pattern are rewritten.
 *      The session header frame is preserved byte for byte.
 *   3. Verify: frame count, header bytes and "no remaining hits" are checked
 *      before the file is replaced; any mismatch aborts without touching it.
 *   4. Prune: manifests older than N days are dropped and unreferenced blobs
 *      are deleted.
 *
 * Deliberate choices (learned the hard way):
 *   - A clean file is never rewritten, so a bug here cannot corrupt history.
 *   - The backup happens BEFORE redaction, so "restore" means "undo this run".
 *   - Blobs are DPAPI-encrypted for the current Windows user; no key is stored
 *     anywhere, which also means a lost profile cannot be recovered.
 *
 * Usage:
 *   node redact.mjs --dry-run
 *   node redact.mjs --apply [--keep-days 90] [--vault <dir>] [--no-backup]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';

import { DEFAULT_SECRETS } from '../dsh-guardrails/rules.js';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_FILE = /^session\.v\d+\.jsonl\.zstd$/;

function parseArgs(argv) {
  const out = {
    apply: false,
    quiet: false,
    backup: true,
    keepDays: 90,
    root: join(homedir(), '.dsh', 'sessions'),
    vault: join(homedir(), '.dsh', 'guardrails', 'vault'),
    policy: join(homedir(), '.dsh', 'guardrails', 'policy.json'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--dry-run') out.apply = false;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--no-backup') out.backup = false;
    else if (arg === '--root') out.root = argv[++i];
    else if (arg === '--vault') out.vault = argv[++i];
    else if (arg === '--policy') out.policy = argv[++i];
    else if (arg === '--keep-days') out.keepDays = Number(argv[++i]);
  }
  return out;
}

/** Split a concatenated zstd stream into frames; a failed slice means a false magic inside data. */
export function splitFrames(buf) {
  const frames = [];
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
    frames.push({ start, end });
    if (end >= buf.length) break;
    start = end;
    cursor = start + 4;
  }
  return frames;
}

export function loadPatterns(policyPath) {
  const extra = [];
  if (policyPath !== null && existsSync(policyPath)) {
    try {
      const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
      for (const pattern of policy?.rules?.secrets?.patterns ?? []) extra.push(pattern);
    } catch {
      // A broken policy file must not disable the built-in patterns.
    }
  }
  return [...DEFAULT_SECRETS, ...extra]
    .map((source) => {
      try {
        return new RegExp(source, 'gi');
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function scanText(text, patterns) {
  let hits = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const found = text.match(pattern);
    if (found !== null) hits += found.length;
  }
  return hits;
}

function redactText(text, patterns) {
  let out = text;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

export function listSessions(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && SESSION_FILE.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  return files;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function localStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Encrypt many files in a single PowerShell call (one process instead of N).
 * Returns the list of files that produced a .dpapi sibling.
 */
function protectMany(files) {
  const list = files.filter((file) => existsSync(file));
  if (list.length === 0) return [];
  const literal = list.map((file) => `'${file.replace(/'/g, "''")}'`).join(',');
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$paths = @(${literal})`,
    'foreach ($p in $paths) {',
    '  try {',
    '    $bytes = [System.IO.File]::ReadAllBytes($p)',
    '    $enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '    [System.IO.File]::WriteAllBytes("$p.dpapi", $enc)',
    '    if (Test-Path "$p.dpapi") { Remove-Item $p -Force }',
    '  } catch { Write-Output "FAILED $p" }',
    '}',
  ].join('\n');
  const scriptPath = join(tmpdir(), `dsh-protect-${process.pid}.ps1`);
  writeFileSync(scriptPath, script, 'utf8');
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { stdio: 'ignore' });
  rmSync(scriptPath, { force: true });
  return list.filter((file) => existsSync(`${file}.dpapi`));
}

/** Copy one file into the blob store (encrypted) unless its hash is already there. */
function storeBlob(bytes, vault) {
  const hash = sha256(bytes);
  const blob = join(vault, 'blobs', `${hash}.dpapi`);
  if (existsSync(blob)) return { hash, path: blob, reused: true };

  mkdirSync(dirname(blob), { recursive: true });
  const staging = join(vault, 'blobs', `${hash}.staging`);
  writeFileSync(staging, bytes);
  const [encrypted] = protectMany([staging]);
  if (encrypted === undefined) {
    rmSync(staging, { force: true });
    throw new Error(`could not encrypt blob ${hash}`);
  }
  renameSync(`${staging}.dpapi`, blob);
  return { hash, path: blob, reused: false };
}

/** Snapshot every session file, reusing blobs whose content is unchanged. */
export function snapshot(files, root, vault) {
  const manifest = { at: new Date().toISOString(), root, files: [] };
  let stored = 0;
  let reused = 0;
  for (const file of files) {
    const bytes = readFileSync(file);
    const { hash, reused: wasReused } = storeBlob(bytes, vault);
    if (wasReused) reused += 1;
    else stored += 1;
    manifest.files.push({
      path: relative(root, file).replace(/\\/g, '/'),
      sha256: hash,
      size: bytes.length,
      mtime: statSync(file).mtimeMs,
    });
  }
  mkdirSync(join(vault, 'manifests'), { recursive: true });
  const manifestPath = join(vault, 'manifests', `${localStamp()}.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifestPath, stored, reused, count: manifest.files.length };
}

/** Drop manifests older than keepDays, then delete blobs no remaining manifest references. */
export function prune(vault, keepDays) {
  const manifestsDir = join(vault, 'manifests');
  if (!existsSync(manifestsDir)) return { manifests: 0, blobs: 0 };
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  let droppedManifests = 0;
  for (const name of readdirSync(manifestsDir)) {
    const full = join(manifestsDir, name);
    if (statSync(full).mtimeMs < cutoff) {
      unlinkSync(full);
      droppedManifests += 1;
    }
  }

  const referenced = new Set();
  for (const name of readdirSync(manifestsDir)) {
    try {
      const manifest = JSON.parse(readFileSync(join(manifestsDir, name), 'utf8'));
      for (const entry of manifest.files ?? []) referenced.add(entry.sha256);
    } catch {
      // An unreadable manifest must not make us delete live blobs.
      for (const blob of readdirSync(join(vault, 'blobs'))) referenced.add(blob.replace(/\.dpapi$/, ''));
    }
  }

  const blobsDir = join(vault, 'blobs');
  let droppedBlobs = 0;
  if (existsSync(blobsDir)) {
    for (const name of readdirSync(blobsDir)) {
      const hash = name.replace(/\.dpapi$/, '');
      if (!referenced.has(hash)) {
        unlinkSync(join(blobsDir, name));
        droppedBlobs += 1;
      }
    }
  }
  return { manifests: droppedManifests, blobs: droppedBlobs };
}

export function rewriteOne(file, patterns, options) {
  const original = readFileSync(file);
  const frames = splitFrames(original);
  if (frames.length === 0) return { status: 'skip', reason: 'unrecognised frame layout' };

  const texts = frames.map((frame) => zlib.zstdDecompressSync(original.subarray(frame.start, frame.end)).toString('utf8'));
  const hits = texts.reduce((sum, text, index) => (index === 0 ? sum : sum + scanText(text, patterns)), 0);
  if (hits === 0) return { status: 'clean', hits: 0 };

  if (options.apply === false) return { status: 'would-redact', hits, frames: frames.length };

  // Frame 0 is the session header: keep the original bytes so the
  // directory-name / cwd contract cannot drift.
  const parts = [original.subarray(frames[0].start, frames[0].end)];
  for (let i = 1; i < frames.length; i += 1) {
    parts.push(zlib.zstdCompressSync(Buffer.from(redactText(texts[i], patterns), 'utf8')));
  }
  const rebuilt = Buffer.concat(parts);

  const check = splitFrames(rebuilt);
  const verified = check.length === frames.length
    && check[0].end - check[0].start === frames[0].end - frames[0].start
    && rebuilt.subarray(check[0].start, check[0].end).equals(original.subarray(frames[0].start, frames[0].end))
    && check.every((frame) => {
      try {
        return scanText(zlib.zstdDecompressSync(rebuilt.subarray(frame.start, frame.end)).toString('utf8'), patterns) === 0;
      } catch {
        return false;
      }
    });

  if (!verified) return { status: 'verify-failed', hits };

  const temp = `${file}.redacting`;
  writeFileSync(temp, rebuilt);
  renameSync(temp, file);
  return { status: 'redacted', hits };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const patterns = loadPatterns(options.policy);
  const files = listSessions(options.root);

  let snap = null;
  if (options.backup && options.apply) {
    try {
      snap = snapshot(files, options.root, options.vault);
    } catch (error) {
      console.error(`snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
  }

  const report = { at: new Date().toISOString(), mode: options.apply ? 'apply' : 'dry-run', root: options.root, snapshot: snap, files: [] };
  const results = files.map((file) => {
    let result;
    try {
      result = rewriteOne(file, patterns, options);
    } catch (error) {
      result = { status: 'error', reason: error instanceof Error ? error.message : String(error) };
    }
    report.files.push({ file: relative(options.root, file).replace(/\\/g, '/'), ...result });
    return result;
  });

  const summary = {
    scanned: files.length,
    clean: results.filter((r) => r.status === 'clean').length,
    matched: results.filter((r) => r.status !== 'clean').length,
    redacted: results.filter((r) => r.status === 'redacted').length,
    failed: results.filter((r) => r.status === 'error' || r.status === 'verify-failed').length,
    snapshot: snap === null ? 'off' : `${snap.count} files (${snap.stored} new, ${snap.reused} reused)`,
  };

  let pruned = null;
  if (options.apply && snap !== null) {
    try {
      pruned = prune(options.vault, options.keepDays);
    } catch {
      pruned = null;
    }
  }

  if (!options.quiet) {
    for (const item of report.files) {
      if (item.status === 'clean') continue;
      console.log(`${item.status.padEnd(13)} ${item.file} (${item.hits ?? '?'} hits)`);
    }
    console.log('');
    if (snap !== null) console.log(`snapshot: ${summary.snapshot} -> ${snap.manifestPath}`);
    console.log(`scanned ${summary.scanned} session files: matched ${summary.matched}, redacted ${summary.redacted}, failed ${summary.failed}`);
    if (pruned !== null) console.log(`pruned: ${pruned.manifests} manifests, ${pruned.blobs} blobs`);
    if (!options.apply) console.log('dry run: nothing was written.');
  }

  try {
    const reportDir = join(homedir(), '.dsh', 'guardrails');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, `redaction-${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch {
    // A missing report must not change the outcome.
  }

  process.exitCode = summary.failed > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
