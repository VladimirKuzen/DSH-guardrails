import test from 'node:test';
import assert from 'node:assert/strict';

import { collectFacts, commandTarget, clipPath, displayPath } from '../lib/facts.js';

const env = {
  USERPROFILE: 'C:\\Users\\Tester',
  HOME: 'C:\\Users\\Tester',
  DSH_HOME: 'C:\\Users\\Tester\\.dsh',
  AGENTS_HOME: 'C:\\Users\\Tester\\.agents',
};

const FILES = new Set(['C:\\work\\a.txt']);
const DIRS = new Map([['C:\\work\\dist', 42]]);

const io = {
  statSync(path) {
    if (DIRS.has(path)) return { isDirectory: () => true };
    if (FILES.has(path)) return { isDirectory: () => false };
    const error = new Error('ENOENT');
    error.code = 'ENOENT';
    throw error;
  },
  readdirSync(path) {
    const size = DIRS.get(path);
    if (size === undefined) throw new Error('ENOENT');
    return Array.from({ length: size }, (_, index) => `f${index}`);
  },
};

const factsOf = (call, verdict = { rule: 'R2', mode: 'ask' }, options = {}) =>
  collectFacts(call, verdict, env, { io, roots: ['~/.dsh'], ...options });

test('facts: writing an existing file reports overwrite', () => {
  const facts = factsOf({ name: 'write', arguments: { file_path: 'C:\\work\\a.txt' } });
  assert.equal(facts.kind, 'overwrite');
  assert.equal(facts.exists, true);
  assert.equal(facts.count, 1);
  assert.equal(facts.reversible, 'no');
  assert.equal(facts.protectedHit, false);
});

test('facts: writing a new file reports create', () => {
  const facts = factsOf({ name: 'write', arguments: { file_path: 'C:\\work\\new.txt' } });
  assert.equal(facts.kind, 'create');
  assert.equal(facts.exists, undefined);
  assert.equal(facts.count, undefined);
  assert.equal(facts.reversible, 'yes');
});

test('facts: recursive delete of a directory counts its entries', () => {
  const facts = factsOf({
    name: 'pwsh',
    arguments: { command: 'Remove-Item -LiteralPath "C:\\work\\dist" -Recurse -Force' },
  });
  assert.equal(facts.kind, 'delete');
  assert.equal(facts.target, 'C:\\work\\dist');
  assert.equal(facts.recursive, true);
  assert.equal(facts.count, 42);
  assert.equal(facts.reversible, 'no');
});

test('facts: move is reported as reversible', () => {
  const facts = factsOf({
    name: 'pwsh',
    arguments: { command: 'Move-Item "C:\\work\\a.txt" "C:\\work\\b.txt"' },
  });
  assert.equal(facts.kind, 'move');
  assert.equal(facts.reversible, 'yes');
});

test('facts: plugin_manager is classified as a plugin change', () => {
  const facts = factsOf({ name: 'plugin_manager', arguments: { action: 'list_plugins' } });
  assert.equal(facts.kind, 'plugin');
});

test('facts: an unrecognized command stays unknown', () => {
  const facts = factsOf({ name: 'pwsh', arguments: { command: 'Get-ChildItem C:\\work' } });
  assert.equal(facts.kind, 'unknown');
  assert.equal(facts.reversible, 'unknown');
});

test('facts: R3 carries the label and never the value', () => {
  const facts = factsOf(
    { name: 'pwsh', arguments: { command: 'echo sk-abcdefghijklmnopqrstuvwxyz' } },
    { rule: 'R3', mode: 'ask', label: 'Ark API Key' },
  );
  assert.equal(facts.kind, 'secret');
  assert.equal(facts.secretLabel, 'Ark API Key');
  assert.ok(!JSON.stringify(facts).includes('sk-abcdefghijklmnopqrstuvwxyz'));
});

test('facts: a target under a protected root is flagged', () => {
  const facts = factsOf(
    { name: 'write', arguments: { file_path: 'C:\\Users\\Tester\\.dsh\\AGENTS.md' } },
    { rule: 'R1', mode: 'ask' },
  );
  assert.equal(facts.protectedHit, true);
  assert.equal(facts.kind, 'create');
});

test('facts: a directory larger than the cap reports 500+', () => {
  const bigIo = {
    statSync: () => ({ isDirectory: () => true }),
    readdirSync: () => Array.from({ length: 600 }, (_, index) => `f${index}`),
  };
  const facts = collectFacts(
    { name: 'pwsh', arguments: { command: 'Remove-Item "C:\\big" -Recurse' } },
    { rule: 'R2', mode: 'ask' },
    env,
    { io: bigIo },
  );
  assert.equal(facts.count, '500+');
});

test('commandTarget: flag, quoted and bare forms', () => {
  assert.equal(commandTarget('Remove-Item -LiteralPath "C:\\work\\dist" -Recurse'), 'C:\\work\\dist');
  assert.equal(commandTarget('Remove-Item -Path C:\\work\\dist -Force'), 'C:\\work\\dist');
  assert.equal(commandTarget('Remove-Item "D:\\tmp\\x"'), 'D:\\tmp\\x');
  assert.equal(commandTarget('Get-Date'), '');
});

test('displayPath and clipPath keep the value readable', () => {
  assert.equal(displayPath('$env:USERPROFILE\\.dsh\\x', env), 'C:\\Users\\Tester\\.dsh\\x');
  assert.equal(displayPath('~/.dsh/y', env), 'C:\\Users\\Tester\\.dsh\\y');
  // A variable the environment does not know stays visible instead of vanishing.
  assert.equal(displayPath('$env:UNKNOWN_VAR\\x', env), '$env:UNKNOWN_VAR\\x');
  assert.equal(displayPath('%UNKNOWN_VAR%\\x', env), '%UNKNOWN_VAR%\\x');
  // A known variable is expanded when present.
  assert.equal(displayPath('$env:TEMP\\x', { ...env, TEMP: 'C:\\Temp' }), 'C:\\Temp\\x');
  const long = 'C:\\' + 'a'.repeat(120);
  const clipped = clipPath(long);
  assert.ok(clipped.length <= 72);
  assert.ok(clipped.includes('…'));
});
