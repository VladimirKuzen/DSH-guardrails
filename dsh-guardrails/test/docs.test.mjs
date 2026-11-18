import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeErrors, validatePolicy } from '../lib/policy/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = resolve(here, '..');
const repo = resolve(here, '..', '..');

/** Directories that hold machine-local state or scratch copies, never shipped docs. */
const SKIP = new Set(['.git', '_backup', '_scratch', 'node_modules', 'audit']);

const i18n = (name) => JSON.parse(readFileSync(join(plugin, 'i18n', name), 'utf8'));
const placeholders = (value) => [...String(value).matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]).sort();

test('i18n: en and zh carry the same keys', () => {
  const en = Object.keys(i18n('en.json')).sort();
  const zh = Object.keys(i18n('zh.json')).sort();
  const missing = en.filter((key) => !zh.includes(key));
  const extra = zh.filter((key) => !en.includes(key));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
});

test('i18n: a key uses the same placeholders in both languages', () => {
  const en = i18n('en.json');
  const zh = i18n('zh.json');
  const mismatched = Object.keys(en).filter(
    (key) => key in zh && placeholders(en[key]).join(',') !== placeholders(zh[key]).join(','),
  );
  assert.deepEqual(mismatched, []);
});

test('i18n: every value is a non-empty string', () => {
  for (const name of ['en.json', 'zh.json']) {
    const table = i18n(name);
    const broken = Object.entries(table).filter(([, value]) => typeof value !== 'string' || value.trim() === '');
    assert.deepEqual(broken, [], `${name} has empty or non-string values`);
  }
});

const walk = (dir, files = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(full, files);
    } else if (entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
};

/** `[label](target)` with an optional title; inline code and fenced blocks are not links. */
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

test('docs: every relative link in the Markdown tree resolves', () => {
  let links = 0;
  const broken = [];
  for (const file of walk(repo)) {
    const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const match of text.matchAll(LINK)) {
      links += 1;
      let target = match[1];
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http(s), mailto
      if (target.startsWith('#')) continue; // same-page anchor
      const path = decodeURI(target.split('#')[0].split('?')[0]);
      if (path === '') continue;
      const resolved = path.startsWith('/') ? join(repo, path) : resolve(dirname(file), path);
      if (!existsSync(resolved)) broken.push(`${file.slice(repo.length + 1)} -> ${target}`);
    }
  }
  // A walker that silently matches nothing would pass; the tree always carries this many links.
  assert.ok(links >= 25, `only ${links} links scanned — the walker or the link pattern broke`);
  assert.deepEqual(broken, []);
});

/** The validator refuses an unanchored `commandMatches`; a copy-pasted sample would fail on load. */
const COMMAND_MATCH = /"commandMatches"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

test('docs: every commandMatches sample is anchored with ^', () => {
  let samples = 0;
  const unanchored = [];
  for (const file of walk(repo)) {
    for (const match of readFileSync(file, 'utf8').matchAll(COMMAND_MATCH)) {
      samples += 1;
      if (!match[1].startsWith('^')) unanchored.push(`${file.slice(repo.length + 1)}: ${match[1]}`);
    }
  }
  assert.ok(samples >= 4, `only ${samples} commandMatches samples found — the scan broke`);
  assert.deepEqual(unanchored, []);
});

/** Shipped docs only: `design/` notes are historical and may quote old, invalid samples. */
const shipped = (file) => {
  const rel = file.slice(repo.length + 1).split('\\').join('/');
  return rel === 'README.md' || rel === 'README.zh-CN.md' || rel.startsWith('dsh-guardrails/docs/');
};

/** A sample that does not load is a bullet in the README that cannot be copy-pasted. */
test('docs: every policy sample in the shipped docs validates', () => {
  const broken = [];
  let checked = 0;
  for (const file of walk(repo).filter(shipped)) {
    for (const block of readFileSync(file, 'utf8').matchAll(/```json\r?\n([\s\S]*?)```/g)) {
      const text = block[1].trim();
      // Snippets such as a lone `"pkg": "link:..."` line are fragments, not documents.
      if (!text.startsWith('{')) continue;
      let policy;
      try {
        policy = JSON.parse(text);
      } catch (error) {
        broken.push(`${file.slice(repo.length + 1)}: ${error.message}`);
        continue;
      }
      if (policy === null || typeof policy !== 'object' || policy.version === undefined) continue;
      checked += 1;
      const result = validatePolicy(policy);
      if (!result.ok) broken.push(`${file.slice(repo.length + 1)}: ${describeErrors(result.errors)}`);
    }
  }
  assert.ok(checked >= 3, `only ${checked} policy samples validated`);
  assert.deepEqual(broken, []);
});

/** PowerShell re-quotes inline JSON, so a documented inline `--args` cannot be pasted on Windows. */
test('docs: every check.mjs sample passes its arguments through stdin', () => {
  const offending = [];
  let samples = 0;
  for (const file of walk(repo).filter(shipped)) {
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (!line.includes('check.mjs') || !line.includes('--args')) return;
        samples += 1;
        if (!line.includes('--args -')) offending.push(`${file.slice(repo.length + 1)}:${index + 1}`);
      });
  }
  assert.ok(samples >= 4, `only ${samples} check.mjs samples found — the scan broke`);
  assert.deepEqual(offending, []);
});
