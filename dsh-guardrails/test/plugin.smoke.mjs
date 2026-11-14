import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'guardrails-'));
const policyPath = join(dir, 'policy.json');
process.env.DSH_GUARDRAILS_POLICY = policyPath;
process.env.DSH_HOME = join(dir, '.dsh');
process.env.USERPROFILE = 'C:\\Users\\Tester';

const { apply } = await import('../index.js');

/** 最小 ctx：只提供 on/logger。 */
function fakeCtx() {
  const ctx = { handlers: [], logger: { info() {} }, on(event, fn) { ctx.handlers.push({ event, fn }); } };
  apply(ctx, {});
  return ctx.handlers[0].fn;
}

const next = async () => ({ kind: 'allow' });
const call = (name, args) => ({ name, arguments: args, agent: undefined });

function writePolicy(policy) {
  writeFileSync(policyPath, JSON.stringify(policy), 'utf8');
}

function auditLines() {
  const base = join(dir, 'audit');
  try {
    return readdirSync(base).flatMap((f) => readFileSync(join(base, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  } catch {
    return [];
  }
}

test('打包后的插件：命中红线返回 ask，并写审计', async () => {
  rmSync(policyPath, { force: true });
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const fn = fakeCtx();

  const decision = await fn(call('write', { file_path: 'C:\\Users\\Tester\\.dsh\\AGENTS.md', content: 'x' }), next);
  assert.equal(decision.kind, 'ask');
  assert.match(decision.reason, /R1/);
  assert.ok(decision.displayReason.zh.includes('AGENTS.md'));
  assert.ok(decision.displayReason.zh.includes('受保护目录'));
  assert.ok(decision.displayReason.en.includes('protected directory'));

  const lines = auditLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].rule, 'R1');
  assert.equal(lines[0].tool, 'write');
});

test('打包后的插件：审批文案带事实摘要', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const fn = fakeCtx();
  const decision = await fn(call('pwsh', { command: 'Remove-Item -Recurse .\\dist' }), next);
  assert.equal(decision.kind, 'ask');
  assert.ok(decision.displayReason.zh.includes('删除'));
  assert.ok(decision.displayReason.zh.includes('不可恢复'));
  assert.ok(decision.displayReason.en.includes('Delete'));
  assert.ok(decision.displayReason.en.includes('irreversible'));
});

test('打包后的插件：未命中时透传', async () => {
  const fn = fakeCtx();
  const decision = await fn(call('write', { file_path: 'D:\\work\\a.txt', content: 'x' }), next);
  assert.deepEqual(decision, { kind: 'allow' });
});

test('打包后的插件：deny 模式直接拒绝', async () => {
  writePolicy({
    enabled: true,
    auditDir: join(dir, 'audit'),
    rules: { destructive: { mode: 'deny' } },
  });
  const fn = fakeCtx();
  const decision = await fn(call('pwsh', { command: 'Remove-Item -Recurse .\\dist' }), next);
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.info.code, 'R2');
});

test('打包后的插件：R3 在 shell 命令里直接拒绝，且审计不含密钥原文', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const fn = fakeCtx();
  const secret = 'sk-' + 'a'.repeat(32);
  const decision = await fn(call('pwsh', { command: `export KEY=${secret}` }), next);
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /api-keys\.json/);
  const raw = readdirSync(join(dir, 'audit')).map((f) => readFileSync(join(dir, 'audit', f), 'utf8')).join('');
  assert.ok(!raw.includes(secret), 'audit 不应包含密钥');
});

test('打包后的插件：R3 在文件写入里仍然弹审批', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const fn = fakeCtx();
  const secret = 'sk-' + 'b'.repeat(32);
  const decision = await fn(call('write', {
    file_path: 'D:\\work\\secrets.json',
    content: `{"key":"${secret}"}`,
  }), next);
  assert.equal(decision.kind, 'ask');
  assert.ok(decision.displayReason.zh.includes('参数含密钥'));
  assert.ok(decision.displayReason.zh.includes('无法撤回'));
  assert.ok(!decision.displayReason.zh.includes(secret));
});

test('打包后的插件：策略文件损坏时沿用上一份，不抛错', async () => {
  const fn = fakeCtx();
  writePolicy('{ this is not json');
  // 2 秒 TTL 内走缓存；再等一次读取也不会抛
  const decision = await fn(call('write', { file_path: 'D:\\work\\a.txt', content: 'x' }), next);
  assert.deepEqual(decision, { kind: 'allow' });
});

test('打包后的插件：磁盘操作直接拒绝，severity 进入审计', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const fn = fakeCtx();
  const decision = await fn(call('pwsh', { command: 'format D:' }), next);
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /critical/);

  const last = auditLines().at(-1);
  assert.equal(last.rule, 'R2');
  assert.equal(last.severity, 'critical');
  assert.equal(last.decision, 'denied');
});

test('打包后的插件：critical 降级为 ask 时标题用 ⛔ 与事实', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit'), rules: { critical: { mode: 'ask' } } });
  const fn = fakeCtx();
  const decision = await fn(call('pwsh', { command: 'Remove-Item "C:\\Windows\\System32\\x.dll" -Force' }), next);
  assert.equal(decision.kind, 'ask');
  assert.ok(decision.displayReason.zh.startsWith('⛔'), decision.displayReason.zh);
  assert.ok(decision.displayReason.zh.includes('系统目录'), decision.displayReason.zh);
  assert.ok(decision.displayReason.en.includes('system directory'), decision.displayReason.en);
});
