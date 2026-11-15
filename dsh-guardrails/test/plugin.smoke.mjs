import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'guardrails-'));
const policyPath = join(dir, 'policy.json');
process.env.DSH_GUARDRAILS_POLICY = policyPath;
process.env.DSH_HOME = join(dir, '.dsh');
process.env.USERPROFILE = 'C:\\Users\\Tester';

const { apply } = await import('../index.js');

/** Minimal ctx: records handlers by event name. */
function fakeCtx() {
  const handlers = new Map();
  const ctx = { logger: { info() {} }, on(event, fn) { handlers.set(event, fn); } };
  apply(ctx, {});
  return {
    pre: handlers.get('tools/pre-execute'),
    session: handlers.get('session/event'),
    post: handlers.get('tools/post-execute'),
  };
}

const next = async () => ({ kind: 'allow' });
const call = (name, args, callId) => ({ name, arguments: args, agent: undefined, ...(callId === undefined ? {} : { callId }) });

function writePolicy(policy) {
  writeFileSync(policyPath, JSON.stringify(policy), 'utf8');
}

function v2Dir() {
  return join(dir, 'audit', 'v2');
}

function auditLines() {
  const base = v2Dir();
  try {
    return readdirSync(base)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => readFileSync(join(base, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  } catch {
    return [];
  }
}

function v1Lines() {
  const base = join(dir, 'audit');
  try {
    return readdirSync(base)
      .filter((f) => /^audit-.*\.jsonl$/.test(f))
      .flatMap((f) => readFileSync(join(base, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  } catch {
    return [];
  }
}

test('R1 hit returns ask and writes requested + payload', async () => {
  rmSync(join(dir, 'audit'), { recursive: true, force: true });
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const ctx = fakeCtx();

  const decision = await ctx.pre(call('write', { file_path: 'C:\\Users\\Tester\\.dsh\\AGENTS.md', content: 'x' }, 'c1'), next);
  assert.equal(decision.kind, 'ask');
  assert.match(decision.reason, /R1/);
  assert.ok(decision.displayReason.zh.includes('AGENTS.md'));
  assert.ok(decision.displayReason.en.includes('protected directory'));

  const lines = auditLines();
  assert.equal(lines.length, 1);
  const [record] = lines;
  assert.equal(record.event, 'requested');
  assert.equal(record.rule, 'R1');
  assert.equal(record.tool, 'write');
  assert.equal(record.callId, 'c1');
  assert.equal(record.delivered, false);
  assert.ok(record.payloadRef.startsWith('payload/'));
  assert.equal(readFileSync(join(dir, 'audit', 'v2', record.payloadRef), 'utf8').includes('AGENTS.md'), true);
  assert.match(record.hash, /^[0-9a-f]{64}$/);
});

test('approved call logs delivered, outcome and executed', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const ctx = fakeCtx();

  await ctx.pre(call('pwsh', { command: 'Remove-Item -Recurse .\\dist' }, 'c2'), next);
  ctx.session({ id: 's1' }, { type: 'approval/asked', data: { id: 'apr-1', callId: 'c2', toolName: 'pwsh' } });
  ctx.session({ id: 's1' }, { type: 'approval/decided', data: { id: 'apr-1', outcome: 'allowed-once' } });
  await ctx.post({ name: 'pwsh', callId: 'c2', arguments: { command: 'Remove-Item -Recurse .\\dist' } }, { isError: false }, next);

  const events = auditLines().filter((r) => r.callId === 'c2').map((r) => r.event);
  assert.deepEqual(events, ['requested', 'delivered', 'outcome', 'executed']);
  const executed = auditLines().find((r) => r.event === 'executed');
  assert.equal(executed.isError, false);
});

test('rejected call logs outcome but never executed', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const ctx = fakeCtx();

  await ctx.pre(call('pwsh', { command: 'Remove-Item -Recurse .\\dist' }, 'c3'), next);
  ctx.session({ id: 's1' }, { type: 'approval/asked', data: { id: 'apr-2', callId: 'c3' } });
  ctx.session({ id: 's1' }, { type: 'approval/decided', data: { id: 'apr-2', outcome: 'rejected' } });
  // A denied call still reaches post-execute with an error result.
  await ctx.post({ name: 'pwsh', callId: 'c3', arguments: {} }, { isError: true }, next);

  const events = auditLines().filter((r) => r.callId === 'c3').map((r) => r.event);
  assert.deepEqual(events, ['requested', 'delivered', 'outcome']);
  const outcome = auditLines().find((r) => r.callId === 'c3' && r.event === 'outcome');
  assert.equal(outcome.outcome, 'rejected');
  assert.equal(outcome.source, 'user');
});

test('clean call passes through', async () => {
  const ctx = fakeCtx();
  const decision = await ctx.pre(call('write', { file_path: 'D:\\work\\a.txt', content: 'x' }), next);
  assert.deepEqual(decision, { kind: 'allow' });
});

test('deny mode refuses and logs requested + outcome(denied, guardrail)', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit'), rules: { destructive: { mode: 'deny' } } });
  const ctx = fakeCtx();

  const decision = await ctx.pre(call('pwsh', { command: 'Remove-Item -Recurse .\\dist' }, 'c4'), next);
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.info.code, 'R2');
  const records = auditLines().filter((r) => r.callId === 'c4');
  assert.deepEqual(records.map((r) => `${r.event}:${r.outcome ?? ''}`), ['requested:', 'outcome:denied']);
  assert.equal(records[1].source, 'guardrail');
});

test('R3 shell deny never writes the secret or its payload', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const ctx = fakeCtx();
  const secret = 'sk-' + 'a'.repeat(32);
  const decision = await ctx.pre(call('pwsh', { command: `export KEY=${secret}` }), next);
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /api-keys\.json/);

  const all = readdirSync(join(dir, 'audit', 'v2'), { recursive: true })
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.txt'))
    .map((f) => readFileSync(join(dir, 'audit', 'v2', f), 'utf8'))
    .join('');
  assert.ok(!all.includes(secret), 'audit must not contain the secret');
  const record = auditLines().find((r) => r.rule === 'R3');
  assert.equal(record.payloadRef, null);
  assert.match(record.payloadSha256, /^[0-9a-f]{64}$/);
});

test('R3 secret write still asks and hides the value', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const ctx = fakeCtx();
  const secret = 'sk-' + 'b'.repeat(32);
  const decision = await ctx.pre(call('write', {
    file_path: 'D:\\work\\secrets.json',
    content: `{"key":"${secret}"}`,
  }), next);
  assert.equal(decision.kind, 'ask');
  assert.ok(decision.displayReason.zh.includes('参数含密钥'));
  assert.ok(!decision.displayReason.zh.includes(secret));
});

test('a corrupt policy keeps the last good copy', async () => {
  const ctx = fakeCtx();
  writePolicy('{ this is not json');
  const decision = await ctx.pre(call('write', { file_path: 'D:\\work\\a.txt', content: 'x' }), next);
  assert.deepEqual(decision, { kind: 'allow' });
});

test('critical deny logs severity', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const ctx = fakeCtx();
  const decision = await ctx.pre(call('pwsh', { command: 'format D:' }, 'c5'), next);
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /critical/);

  const requested = auditLines().find((r) => r.callId === 'c5' && r.event === 'requested');
  assert.equal(requested.rule, 'R2');
  assert.equal(requested.severity, 'critical');
});

test('critical downgraded to ask shows the ⛔ headline', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit'), rules: { critical: { mode: 'ask' } } });
  const ctx = fakeCtx();
  const decision = await ctx.pre(call('pwsh', { command: 'Remove-Item "C:\\Windows\\System32\\x.dll" -Force' }), next);
  assert.equal(decision.kind, 'ask');
  assert.ok(decision.displayReason.zh.startsWith('⛔'), decision.displayReason.zh);
  assert.ok(decision.displayReason.zh.includes('系统目录'), decision.displayReason.zh);
});

test('audit.format "v1" keeps the old single-file format', async () => {
  rmSync(join(dir, 'audit'), { recursive: true, force: true });
  writePolicy({ enabled: true, auditDir: join(dir, 'audit'), audit: { format: 'v1' } });
  const ctx = fakeCtx();

  const decision = await ctx.pre(call('write', { file_path: 'C:\\Users\\Tester\\.dsh\\AGENTS.md', content: 'x' }), next);
  assert.equal(decision.kind, 'ask');
  const lines = v1Lines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].decision, 'asked');
  assert.equal(lines[0].rule, 'R1');
  assert.equal(existsSync(v2Dir()), false);
});
