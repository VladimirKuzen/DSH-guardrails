import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
