import test from 'node:test';
import assert from 'node:assert/strict';

import { describe, LOCALES } from '../lib/describe.js';

const deleteFacts = {
  kind: 'delete',
  target: 'C:\\work\\dist',
  exists: true,
  isDir: true,
  count: 42,
  recursive: true,
  reversible: 'no',
  protectedHit: false,
  secretLabel: '',
};

const overwriteFacts = {
  kind: 'overwrite',
  target: 'C:\\Users\\Tester\\.dsh\\AGENTS.md',
  exists: true,
  isDir: false,
  count: 1,
  reversible: 'no',
  protectedHit: true,
  secretLabel: '',
};

const secretFacts = {
  kind: 'secret',
  target: '',
  exists: undefined,
  count: undefined,
  reversible: 'no',
  protectedHit: false,
  secretLabel: 'Ark API Key',
};

test('describe: recursive delete reads as a verdict, not a rule id', () => {
  const text = describe({ rule: 'R2', mode: 'ask' }, deleteFacts);
  assert.equal(text.zh, '⚠ 删除目录（递归）｜目标 C:\\work\\dist｜42 个文件｜不可恢复');
  assert.equal(text.en, '⚠ Delete directory (recursive) · at C:\\work\\dist · 42 files · irreversible');
});

test('describe: overwrite mentions that the file exists and the root is protected', () => {
  const text = describe({ rule: 'R1', mode: 'ask' }, overwriteFacts);
  assert.ok(text.zh.includes('覆写文件'));
  assert.ok(text.zh.includes('已存在'));
  assert.ok(text.zh.includes('受保护目录'));
  assert.ok(text.zh.includes('1 个文件'));
  assert.ok(text.en.includes('exists'));
  assert.ok(text.en.includes('protected directory'));
});

test('describe: a deny uses the block prefix', () => {
  const text = describe({ rule: 'R2', mode: 'deny' }, deleteFacts);
  assert.ok(text.zh.startsWith('⛔'));
  assert.ok(text.en.startsWith('⛔'));
});

test('describe: a secret shows its label and no value', () => {
  const text = describe({ rule: 'R3', mode: 'ask' }, secretFacts);
  assert.equal(text.zh, '⚠ 参数含密钥（Ark API Key）');
  assert.equal(text.en, '⚠ Secret in arguments (Ark API Key)');
  assert.ok(!text.zh.includes('sk-'));
});

test('describe: unknown kind still produces a sentence', () => {
  const facts = { kind: 'unknown', target: '', count: undefined, reversible: 'unknown', protectedHit: false };
  const text = describe({ rule: 'R2', mode: 'ask' }, facts);
  assert.ok(text.zh.includes('未识别操作'));
  assert.ok(text.en.includes('Unrecognized action'));
});

test('locales: both packs define identical keys and placeholders', () => {
  const zhKeys = Object.keys(LOCALES.zh).sort();
  const enKeys = Object.keys(LOCALES.en).sort();
  assert.deepEqual(zhKeys, enKeys);

  const placeholders = (value) => (value.match(/\{(\w+)\}/g) ?? []).sort();
  for (const key of zhKeys) {
    assert.deepEqual(placeholders(LOCALES.zh[key]), placeholders(LOCALES.en[key]), `placeholder mismatch: ${key}`);
  }
});

test('describe: output stays single-line and within the card budget', () => {
  const text = describe({ rule: 'R2', mode: 'ask' }, deleteFacts);
  for (const value of Object.values(text)) {
    assert.ok(!value.includes('\n'));
    assert.ok(value.length <= 140, `too long (${value.length}): ${value}`);
  }
});
