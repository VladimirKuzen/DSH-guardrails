import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, expandPath, DEFAULT_SECRETS } from '../rules.js';

const env = {
  USERPROFILE: 'C:\\Users\\Tester',
  DSH_HOME: 'C:\\Users\\Tester\\.dsh',
  AGENTS_HOME: 'C:\\Users\\Tester\\.agents',
};

const policy = {
  enabled: true,
  rules: {
    protectDshHome: { mode: 'ask', roots: ['~/.dsh', '~/.agents'] },
    destructive: { mode: 'ask' },
    secrets: { mode: 'ask' },
  },
};

const call = (name, args) => ({ name, arguments: args });
const rules = (v) => v?.rule ?? null;

test('R1: 写入 ~/.dsh 会拦', () => {
  const verdict = evaluate(policy, call('write', {
    file_path: 'C:\\Users\\Tester\\.dsh\\AGENTS.md',
    content: 'hi',
  }), env);
  assert.equal(rules(verdict), 'R1');
  assert.equal(verdict.mode, 'ask');
});

test('R1: 写入工作区放行', () => {
  assert.equal(evaluate(policy, call('write', {
    file_path: 'D:\\work\\notes.md',
    content: 'hi',
  }), env), null);
});

test('R1: ~ 与 %VAR% 都能展开', () => {
  assert.equal(expandPath('~/.dsh/AGENTS.md', env), 'c:\\users\\tester\\.dsh\\agents.md');
  assert.equal(expandPath('%USERPROFILE%\\.dsh\\x', env), 'c:\\users\\tester\\.dsh\\x');
  assert.equal(expandPath('$env:DSH_HOME\\y', env), 'c:\\users\\tester\\.dsh\\y');
});

test('R1: 只读命令不拦', () => {
  assert.equal(evaluate(policy, call('pwsh', {
    command: 'Get-Content $env:USERPROFILE\\.dsh\\AGENTS.md',
  }), env), null);
});

test('R1: shell 写入 .dsh 会拦', () => {
  const verdict = evaluate(policy, call('pwsh', {
    command: 'Set-Content "$env:USERPROFILE\\.dsh\\AGENTS.md" -Value "x"',
  }), env);
  assert.equal(rules(verdict), 'R1');
});

test('R1: plugin_manager 一律拦', () => {
  assert.equal(rules(evaluate(policy, call('plugin_manager', { action: 'list_bundles' }), env)), 'R1');
});

test('R2: 删除与移动会拦', () => {
  assert.equal(rules(evaluate(policy, call('pwsh', { command: 'Remove-Item -Recurse .\\build' }), env)), 'R2');
  assert.equal(rules(evaluate(policy, call('pwsh', { command: 'Move-Item a.txt b.txt' }), env)), 'R2');
  assert.equal(rules(evaluate(policy, call('pwsh', { command: 'git reset --hard HEAD~1' }), env)), 'R2');
});

test('R2: 日常命令放行', () => {
  for (const command of [
    'Get-ChildItem -Force',
    'git status',
    'python price_probe.py --dry-run',
    'git commit -m "rm old files from README"',
    'npm run build',
  ]) {
    assert.equal(evaluate(policy, call('pwsh', { command }), env), null, command);
  }
});

test('R3: 参数里的密钥会拦', () => {
  const verdict = evaluate(policy, call('pwsh', {
    command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" https://example.com',
  }), env);
  assert.equal(rules(verdict), 'R3');
  // 提示里只出现标签，不出现原文
  assert.ok(!JSON.stringify(verdict).includes('abcdefghijklmnopqrstuvwxyz123456'));
});

test('R3: 写文件时正文含密钥也会拦', () => {
  const key = ['ark', '11111111-2222-3333-4444-555555555555'].join('-');
  const verdict = evaluate(policy, call('write', {
    file_path: 'D:\\work\\config.json',
    content: `{"apiKey":"${key}"}`,
  }), env);
  assert.equal(rules(verdict), 'R3');
  assert.equal(verdict.label, '火山方舟 Ark API Key');
});

test('R3: 普通文本不误伤', () => {
  assert.equal(evaluate(policy, call('write', {
    file_path: 'D:\\work\\a.md',
    content: 'token 消耗统计，token=数量不对；password 字段是可选的。',
  }), env), null);
});

test('模式可切换：deny 与 off', () => {
  const deny = { enabled: true, rules: { protectDshHome: { mode: 'deny', roots: ['~/.dsh'] } } };
  assert.equal(evaluate(deny, call('write', { file_path: 'C:\\Users\\Tester\\.dsh\\x' }), env).mode, 'deny');

  const off = { enabled: false };
  assert.equal(evaluate(off, call('write', { file_path: 'C:\\Users\\Tester\\.dsh\\x' }), env), null);

  const secretsOff = { enabled: true, rules: { secrets: { mode: 'off' } } };
  assert.equal(evaluate(secretsOff, call('pwsh', { command: 'echo sk-abcdefghijklmnopqrstuvwxyz' }), env), null);
});

test('自定义模式可追加', () => {
  const custom = {
    enabled: true,
    rules: { destructive: { mode: 'ask', patterns: ['\\bdrop\\s+table\\b'] } },
  };
  assert.equal(evaluate(custom, call('pwsh', { command: 'psql -c "drop table users"' }), env).rule, 'R2');
});

test('内置密钥正则本身不会自我命中', () => {
  // 把默认模式当成普通文本写进文件，不应触发 R3
  const text = DEFAULT_SECRETS.join('\n');
  assert.equal(evaluate(policy, call('write', { file_path: 'D:\\work\\policy.json', content: text }), env), null);
});
