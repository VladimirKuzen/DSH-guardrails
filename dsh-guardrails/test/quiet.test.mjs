import test from 'node:test';
import assert from 'node:assert/strict';

import { decideQuiet } from '../lib/rules/quiet.js';

const CONFIG = {
  enabled: true,
  roots: ['D:\\work\\proj'],
  paths: ['_scratch', 'build'],
  alwaysAsk: ['.git', '.', '..'],
};

const facts = (overrides = {}) => ({
  kind: 'delete',
  target: 'D:\\work\\proj\\_scratch\\a.txt',
  count: 1,
  ...overrides,
});

const decide = (overrides = {}) => decideQuiet({
  tool: 'pwsh',
  command: "Remove-Item 'D:\\work\\proj\\_scratch\\a.txt' -Force",
  facts: facts(),
  config: CONFIG,
  ...overrides,
});

test('a single temp file delete is quiet', () => {
  assert.deepEqual(decide(), { quiet: true, reason: 'eligible' });
});

test('-Force is allowed when there is one target and no recursion', () => {
  const result = decide({ command: "Remove-Item 'D:\\work\\proj\\_scratch\\a.txt' -Force" });
  assert.equal(result.quiet, true);
});

test('-Recurse always asks', () => {
  const result = decide({ command: "Remove-Item 'D:\\work\\proj\\_scratch\\a.txt' -Recurse" });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'recursive');
});

test('a wildcard target asks', () => {
  const result = decide({
    command: "Remove-Item 'D:\\work\\proj\\_scratch\\*.txt'",
    facts: facts({ target: 'D:\\work\\proj\\_scratch\\*.txt' }),
  });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'wildcard');
});

test('an unresolved variable asks instead of guessing', () => {
  const result = decide({
    command: 'Remove-Item "$env:TEMP\\a.txt"',
    facts: facts({ target: '$env:TEMP\\a.txt' }),
  });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'unresolved');
});

test('a path under .git asks', () => {
  const result = decide({ facts: facts({ target: 'D:\\work\\proj\\_scratch\\.git\\config' }) });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'always-ask');
});

test('the whitelisted directory itself asks', () => {
  const result = decide({ facts: facts({ target: 'D:\\work\\proj\\_scratch' }) });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'always-ask');
});

test('a path outside the configured root asks', () => {
  const result = decide({ facts: facts({ target: 'D:\\other\\_scratch\\a.txt' }) });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'outside-roots');
});

test('a path outside the quiet paths asks', () => {
  const result = decide({ facts: facts({ target: 'D:\\work\\proj\\src\\a.txt' }) });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'outside-paths');
});

test('a nested path inside a quiet directory is still quiet', () => {
  const result = decide({ facts: facts({ target: 'D:\\work\\proj\\_scratch\\a\\b.txt' }) });
  assert.equal(result.quiet, true);
});

test('a drive root in roots is a config error', () => {
  const result = decide({ config: { ...CONFIG, roots: ['D:\\'] } });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'config-invalid');
});

test('a path entry with ".." is a config error', () => {
  const result = decide({ config: { ...CONFIG, paths: ['..'] } });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'config-invalid');
});

test('a cwd outside roots is a config error', () => {
  const result = decide({ cwd: 'D:\\elsewhere' });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'cwd-mismatch');
});

test('an unknown cwd does not disable quiet', () => {
  const result = decide({ cwd: null });
  assert.equal(result.quiet, true);
});

test('multi-statement commands ask', () => {
  const result = decide({ command: "Remove-Item 'D:\\work\\proj\\_scratch\\a.txt'; Get-Date" });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'multi-statement');
});

test('a non-shell tool is never quiet', () => {
  const result = decide({ tool: 'write' });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'tool');
});

test('quiet disabled means no change', () => {
  const result = decide({ config: { ...CONFIG, enabled: false } });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'disabled');
});

test('a move counts as a single-target delete', () => {
  const result = decide({ facts: facts({ kind: 'move' }) });
  assert.equal(result.quiet, true);
});

test('more than one target asks', () => {
  const result = decide({ facts: facts({ count: 2 }) });
  assert.equal(result.quiet, false);
  assert.equal(result.reason, 'count');
});
