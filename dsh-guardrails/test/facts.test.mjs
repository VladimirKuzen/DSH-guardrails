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
    { rule: 'R3', mode: 'ask', label: 'ark' },
  );
  assert.equal(facts.kind, 'secret');
  assert.equal(facts.secretLabel, 'ark');
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

test('commandTarget: -Path inside Join-Path is not a flag', () => {
  assert.equal(commandTarget('Join-Path $env:TEMP "x.mjs"'), '');
});

test('facts: a multi-statement script targets its action statement only', () => {
  const facts = factsOf({
    name: 'pwsh',
    arguments: { command: "Join-Path $env:TEMP 'x.mjs'\nRemove-Item $tmp -Force" },
  });
  assert.equal(facts.kind, 'delete');
  assert.equal(facts.target, '');
  assert.equal(facts.lines, 2);
});

test('facts: New-Item -ItemType Directory reports a directory', () => {
  const facts = factsOf({
    name: 'pwsh',
    arguments: { command: 'New-Item -ItemType Directory -Path C:\\work\\d | Out-Null' },
  });
  assert.equal(facts.kind, 'create-dir');
  assert.equal(facts.target, 'C:\\work\\d');
});

test('commandTarget: a registry key is the target, not its /v switch', () => {
  assert.equal(
    commandTarget('reg add HKCU\\Software\\DeepSeekP16Probe /v Probe /t REG_SZ /d ok /f'),
    'HKCU\\Software\\DeepSeekP16Probe',
  );
  assert.equal(commandTarget('/v'), '');
});

test('commandTarget: unix paths are only recognized for bash', () => {
  assert.equal(commandTarget('/etc/passwd'), '');
  assert.equal(commandTarget('/etc/passwd', { unix: true }), '/etc/passwd');
  assert.equal(commandTarget('rm -rf /etc/x', { unix: true }), '/etc/x');
});

test('facts: reg add names its key and cannot prove reversibility', () => {
  const facts = factsOf({
    name: 'pwsh',
    arguments: { command: 'reg add HKCU\\Software\\DeepSeekP16Probe /v Probe /t REG_SZ /d ok /f' },
  });
  assert.equal(facts.kind, 'registry');
  assert.equal(facts.registryAction, 'add');
  assert.equal(facts.target, 'HKCU\\Software\\DeepSeekP16Probe');
  assert.equal(facts.reversible, 'unknown');
});

test('facts: reg delete is irreversible', () => {
  const facts = factsOf({
    name: 'pwsh',
    arguments: { command: 'reg delete HKCU\\Software\\DeepSeekP16Probe /f' },
  });
  assert.equal(facts.kind, 'registry');
  assert.equal(facts.registryAction, 'delete');
  assert.equal(facts.target, 'HKCU\\Software\\DeepSeekP16Probe');
  assert.equal(facts.reversible, 'no');
});

test('facts: a PowerShell provider write is a registry add', () => {
  const facts = factsOf({
    name: 'pwsh',
    arguments: { command: 'Set-ItemProperty -Path HKCU:\\Software\\X -Name Y -Value 1' },
  });
  assert.equal(facts.kind, 'registry');
  assert.equal(facts.registryAction, 'add');
  assert.equal(facts.target, 'HKCU:\\Software\\X');
});

test('facts: reg import shows the file and stays out of the wildcard path', () => {
  const facts = factsOf({
    name: 'pwsh',
    arguments: { command: 'reg import C:\\work\\p16.reg' },
  });
  assert.equal(facts.kind, 'registry');
  assert.equal(facts.registryAction, 'import');
  assert.equal(facts.target, 'C:\\work\\p16.reg');
  assert.equal(facts.wildcard, undefined);
});

test('facts: a wildcard provider path is flagged as a pattern', () => {
  const facts = factsOf({
    name: 'pwsh',
    arguments: { command: 'Remove-Item -Path HKCU:\\Software\\DeepSeekP16* -Recurse -Force' },
  });
  assert.equal(facts.kind, 'registry');
  assert.equal(facts.registryAction, 'delete');
  assert.equal(facts.wildcard, true);
});

test('facts: R1 shell reports the protected path, not the -Path flag', () => {
  const facts = factsOf({
    name: 'pwsh',
    arguments: { command: 'Set-Content -Path "$env:USERPROFILE\\.dsh\\AGENTS.md" -Value x' },
  }, { rule: 'R1', mode: 'ask' });
  assert.equal(facts.kind, 'protected');
  assert.equal(facts.target, 'C:\\Users\\Tester\\.dsh\\AGENTS.md');
  assert.equal(facts.protectedHit, true);
});

test('facts: the card describes the worst action, not the first one', () => {
  // A setup step that creates a directory must not hide the delete that follows.
  const facts = factsOf({
    name: 'pwsh',
    arguments: {
      command:
        'New-Item -ItemType Directory -Force -Path "C:\\work\\out" | Out-Null; Remove-Item -LiteralPath "C:\\work\\a.txt" -Force',
    },
  });
  assert.equal(facts.kind, 'delete');
  assert.equal(facts.target, 'C:\\work\\a.txt');
  assert.equal(facts.reversible, 'no');
});

test('facts: a variable target stays unnamed and says so', () => {
  const facts = factsOf({
    name: 'pwsh',
    arguments: { command: 'Remove-Item -LiteralPath "C:\\work\\$name" -Force' },
  });
  assert.equal(facts.kind, 'delete');
  assert.equal(facts.target, '');
  assert.equal(facts.dynamic, true);
});

test('facts: a resolved target is not marked dynamic', () => {
  const facts = factsOf({
    name: 'pwsh',
    arguments: { command: 'Remove-Item -LiteralPath "C:\\work\\a.txt" -Force' },
  });
  assert.equal(facts.target, 'C:\\work\\a.txt');
  assert.equal(facts.dynamic, undefined);
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
