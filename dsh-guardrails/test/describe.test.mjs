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
  secretLabel: 'ark',
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
  assert.equal(text.zh, '⚠ 参数含密钥（火山方舟 Ark API Key）');
  assert.equal(text.en, '⚠ Secret in arguments (Ark API key)');
  assert.ok(!text.zh.includes('sk-'));
});

test('describe: a secret about to be written warns that it persists', () => {
  const text = describe({ rule: 'R3', mode: 'ask' }, { ...secretFacts, tool: 'write' });
  assert.ok(text.zh.includes('写入后无法撤回'));
  assert.ok(text.en.includes('cannot be undone once written'));
});

test('describe: unknown kind still produces a sentence', () => {
  const facts = { kind: 'unknown', target: '', count: undefined, reversible: 'unknown', protectedHit: false };
  const text = describe({ rule: 'R2', mode: 'ask' }, facts);
  assert.ok(text.zh.includes('未识别操作'));
  assert.ok(text.en.includes('Unrecognized action'));
});

test('describe: a new directory reads as a directory', () => {
  const text = describe({ rule: 'R2', mode: 'ask' }, {
    kind: 'create-dir',
    target: 'C:\\work\\d',
    reversible: 'yes',
    protectedHit: false,
  });
  assert.equal(text.zh, '⚠ 新建目录｜目标 C:\\work\\d｜可恢复');
});

test('describe: a long command advertises its line count', () => {
  const text = describe({ rule: 'R1', mode: 'ask' }, {
    kind: 'protected',
    target: 'C:\\Users\\x\\.dsh\\a',
    reversible: 'unknown',
    protectedHit: true,
    lines: 8,
  });
  assert.ok(text.zh.includes('命令 8 行'));
  assert.ok(text.en.includes('8 command lines'));
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

test('describe: a registry add names the key and does not claim irreversibility', () => {
  const facts = {
    kind: 'registry',
    registryAction: 'add',
    target: 'HKCU\\Software\\DeepSeekP16Probe',
    reversible: 'unknown',
    protectedHit: false,
  };
  const text = describe({ rule: 'R2', mode: 'ask' }, facts);
  assert.equal(text.zh, '⚠ 新增注册表键或值｜目标 HKCU\\Software\\DeepSeekP16Probe｜恢复方式待评估');
  assert.equal(text.en, '⚠ Add a registry key or value · at HKCU\\Software\\DeepSeekP16Probe · recovery method not assessed');
  assert.ok(!text.zh.includes('不可恢复'));
});

test('describe: a registry delete keeps the irreversibility warning', () => {
  const text = describe({ rule: 'R2', mode: 'ask' }, {
    kind: 'registry',
    registryAction: 'delete',
    target: 'HKCU\\Software\\X',
    reversible: 'no',
    protectedHit: false,
  });
  assert.equal(text.zh, '⚠ 删除注册表键｜目标 HKCU\\Software\\X｜不可恢复');
});

test('describe: a registry import says the script contents are invisible', () => {
  const text = describe({ rule: 'R2', mode: 'ask' }, {
    kind: 'registry',
    registryAction: 'import',
    target: 'C:\\work\\p16.reg',
    reversible: 'unknown',
    protectedHit: false,
  });
  assert.equal(text.zh, '⚠ 修改注册表｜目标 C:\\work\\p16.reg｜脚本内容不可见｜恢复方式待评估');
  assert.ok(text.en.includes('script contents not visible'));
});

test('describe: a wildcard target advertises an unknown scope', () => {
  const text = describe({ rule: 'R2', mode: 'ask' }, {
    kind: 'registry',
    registryAction: 'delete',
    target: 'HKCU:\\Software\\DeepSeekP16*',
    wildcard: true,
    reversible: 'no',
    protectedHit: false,
  });
  assert.equal(text.zh, '⚠ 删除注册表键｜目标 HKCU:\\Software\\DeepSeekP16*｜含通配符，影响范围未知｜不可恢复');
  assert.ok(text.en.includes('wildcard target, scope unknown'));
});

test('describe: a critical verdict uses the block prefix and its category', () => {
  const disk = describe({ rule: 'R2', severity: 'critical', mode: 'deny', category: 'disk' }, {
    kind: 'unknown',
    criticalCategory: 'disk',
    target: '',
    reversible: 'no',
    protectedHit: false,
  });
  assert.ok(disk.zh.startsWith('⛔ 磁盘级操作'), disk.zh);
  assert.ok(disk.en.startsWith('⛔ Disk-level operation'), disk.en);

  const system = describe({ rule: 'R2', severity: 'critical', mode: 'ask', category: 'systemfiles' }, {
    kind: 'unknown',
    criticalCategory: 'systemfiles',
    target: 'C:\\Windows\\System32\\x.dll',
    reversible: 'no',
    protectedHit: false,
  });
  assert.ok(system.zh.includes('删除/覆盖系统目录内容'));
  assert.ok(system.zh.includes('C:\\Windows\\System32\\x.dll'));
  assert.ok(system.en.includes('system directory'));
});

test('describe: output stays single-line and within the card budget', () => {
  const text = describe({ rule: 'R2', mode: 'ask' }, deleteFacts);
  for (const value of Object.values(text)) {
    assert.ok(!value.includes('\n'));
    assert.ok(value.length <= 140, `too long (${value.length}): ${value}`);
  }
});
