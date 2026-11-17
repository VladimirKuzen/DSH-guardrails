import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'guardrails-'));
const policyPath = join(dir, 'policy.json');
process.env.DSH_GUARDRAILS_POLICY = policyPath;
process.env.DSH_HOME = join(dir, '.dsh');
process.env.USERPROFILE = 'C:\\Users\\Tester';

const { apply } = await import('../index.js');
const { pluginRoot } = await import('../lib/rules/r1-self.js');

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

test('self-protection: the record names the sub-rule and the card says protected', async () => {
  rmSync(join(dir, 'audit'), { recursive: true, force: true });
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const ctx = fakeCtx();

  const target = join(pluginRoot(), 'rules.js');
  const decision = await ctx.pre(call('write', { file_path: target, content: 'x' }, 'c9'), next);
  assert.equal(decision.kind, 'ask');
  assert.match(decision.reason, /own source/);

  const [record] = auditLines();
  assert.equal(record.rule, 'R1');
  assert.equal(record.sub, 'self');
  assert.equal(record.facts.protectedHit, true);
  assert.ok(decision.displayReason.zh.includes('受保护目录'));
});

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
  // No hash either: a hash of a low-entropy secret is a dictionary oracle.
  assert.equal(record.payloadSha256, null);
  assert.ok(record.payloadBytes > 0);
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

test('a policy saved with a UTF-8 BOM still loads', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit'), rules: { destructive: { mode: 'deny' } } });
  writeFileSync(policyPath, `\uFEFF${readFileSync(policyPath, 'utf8')}`, 'utf8');
  const ctx = fakeCtx();
  const decision = await ctx.pre(call('pwsh', { command: 'Remove-Item -Recurse D:\\work\\dist' }, 'cbom'), next);
  assert.equal(decision.kind, 'deny', 'a BOM must not turn the whole policy into a parse failure');
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

test('the session cwd is recorded with its source', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const ctx = fakeCtx();

  await ctx.pre({
    name: 'write',
    arguments: { file_path: 'C:\\Users\\Tester\\.dsh\\AGENTS.md', content: 'x' },
    callId: 'c6',
    agent: { session: { id: 's1', cwd: 'D:\\work' } },
  }, next);

  const record = auditLines().find((r) => r.callId === 'c6');
  assert.equal(record.cwd, 'D:\\work');
  assert.equal(record.cwdSource, 'session');
});

test('without a session cwd the shell workdir is recorded as source "tool"', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const ctx = fakeCtx();

  await ctx.pre(call('pwsh', { command: 'Remove-Item -Recurse .\\dist', workdir: 'D:\\work\\sub' }, 'c7'), next);

  const record = auditLines().find((r) => r.callId === 'c7');
  assert.equal(record.cwd, 'D:\\work\\sub');
  assert.equal(record.cwdSource, 'tool');
});

test('a workdir on a non-shell tool is not treated as cwd', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const ctx = fakeCtx();

  await ctx.pre(call('write', { file_path: 'C:\\Users\\Tester\\.dsh\\AGENTS.md', content: 'x', workdir: 'D:\\work' }, 'c8'), next);

  const record = auditLines().find((r) => r.callId === 'c8');
  assert.equal(record.cwd, null);
  assert.equal(record.cwdSource, null);
});

test('workspace quiet allows a temp delete and logs an allowed event', async () => {
  const work = join(dir, 'work');
  const scratch = join(work, '_scratch');
  mkdirSync(scratch, { recursive: true });
  const victim = join(scratch, 'quiet-me.txt');
  writeFileSync(victim, 'x', 'utf8');
  writePolicy({
    enabled: true,
    auditDir: join(dir, 'audit'),
    rules: {
      destructive: { mode: 'ask' },
      quiet: { enabled: true, roots: [work], paths: ['_scratch'], alwaysAsk: ['.git'] },
    },
  });
  const ctx = fakeCtx();

  const decision = await ctx.pre(call('pwsh', { command: `Remove-Item '${victim}' -Force` }, 'q1'), next);
  assert.deepEqual(decision, { kind: 'allow' });

  const record = auditLines().find((r) => r.callId === 'q1');
  assert.equal(record.event, 'allowed');
  assert.equal(record.rule, 'R2');
  assert.equal(record.mode, 'allow');
  assert.equal(record.quiet, 'workspace');
});

test('workspace quiet still asks for a recursive delete', async () => {
  const work = join(dir, 'work');
  // Deliberately the pre-P3 location: a config written before rules.quiet existed
  // must keep behaving the same after the move.
  writePolicy({
    enabled: true,
    auditDir: join(dir, 'audit'),
    rules: {
      destructive: {
        mode: 'ask',
        workspaceQuiet: { enabled: true, roots: [work], paths: ['_scratch'], alwaysAsk: ['.git'] },
      },
    },
  });
  const ctx = fakeCtx();

  const decision = await ctx.pre(call('pwsh', { command: `Remove-Item '${join(work, '_scratch')}' -Recurse -Force` }, 'q2'), next);
  assert.equal(decision.kind, 'ask');
});

test('an observe entry does not turn workspace quiet back into a card', async () => {
  const work = join(dir, 'work');
  const scratch = join(work, '_scratch');
  mkdirSync(scratch, { recursive: true });
  const victim = join(scratch, 'watched.txt');
  writeFileSync(victim, 'x', 'utf8');
  writePolicy({
    version: 2,
    enabled: true,
    auditDir: join(dir, 'audit'),
    rules: {
      destructive: { mode: 'ask' },
      quiet: { enabled: true, roots: [work], paths: ['_scratch'], alwaysAsk: ['.git'] },
    },
    entries: [
      { id: 'watch-scratch', tool: ['pwsh'], mode: 'observe', when: { commandMatches: '^Remove-Item' } },
    ],
  });
  const ctx = fakeCtx();

  const decision = await ctx.pre(call('pwsh', { command: `Remove-Item '${victim}' -Force` }, 'q3'), next);
  assert.deepEqual(decision, { kind: 'allow' });

  // The watcher still shows up in the record: quiet fills the space, it does not
  // erase what else matched.
  const record = auditLines().find((r) => r.callId === 'q3');
  assert.equal(record.event, 'allowed');
  assert.equal(record.quiet, 'workspace');
  assert.ok(record.reasons.some((reason) => reason.entryId === 'watch-scratch'), JSON.stringify(record.reasons));
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

// --- P1.8: two-phase dry run ------------------------------------------------

/** A call that carries a session id, so the per-session dry-run memory is testable. */
const callAs = (sessionId, name, args, callId) => ({
  name,
  arguments: args,
  agent: { session: { id: sessionId } },
  ...(callId === undefined ? {} : { callId }),
});
/** A destructive command whose target the card cannot name: the dry-run trigger. */
const OPAQUE = { command: 'Remove-Item "D:\\work\\$name" -Force' };

function dryRunPolicy(extra = {}) {
  return {
    enabled: true,
    auditDir: join(dir, 'audit'),
    rules: { destructive: { dryRun: { enabled: true, ...extra } } },
  };
}

test('dry run off by default: the first attempt goes straight to a card', async () => {
  writePolicy({ enabled: true, auditDir: join(dir, 'audit') });
  const ctx = fakeCtx();
  const decision = await ctx.pre(callAs('s-off', 'pwsh', OPAQUE), next);
  assert.equal(decision.kind, 'ask');
});

test('dry run: the first attempt is refused with a dry-run instruction, not a card', async () => {
  writePolicy(dryRunPolicy());
  const ctx = fakeCtx();
  const decision = await ctx.pre(callAs('s-1', 'pwsh', OPAQUE), next);
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.info.name, 'GuardrailsDryRun');
  assert.equal(decision.info.code, 'R2');
  assert.match(decision.reason, /dry run/);
  assert.match(decision.reason, /read-only listing/);
  assert.match(decision.reason, /not judged unsafe/);
});

test('dry run: the same command in the same session is carded the second time', async () => {
  writePolicy(dryRunPolicy());
  const ctx = fakeCtx();
  assert.equal((await ctx.pre(callAs('s-2', 'pwsh', OPAQUE), next)).kind, 'deny');
  const retry = await ctx.pre(callAs('s-2', 'pwsh', OPAQUE), next);
  assert.equal(retry.kind, 'ask');
  assert.ok(retry.displayReason.zh.includes('预演'), retry.displayReason.zh);
  assert.ok(retry.displayReason.en.includes('dry run'), retry.displayReason.en);
});

test('dry run: a different session starts over', async () => {
  writePolicy(dryRunPolicy());
  const ctx = fakeCtx();
  assert.equal((await ctx.pre(callAs('s-3a', 'pwsh', OPAQUE), next)).kind, 'deny');
  assert.equal((await ctx.pre(callAs('s-3b', 'pwsh', OPAQUE), next)).kind, 'deny');
});

test('dry run: a differently shaped command is its own first attempt', async () => {
  writePolicy(dryRunPolicy());
  const ctx = fakeCtx();
  assert.equal((await ctx.pre(callAs('s-4', 'pwsh', OPAQUE), next)).kind, 'deny');
  const other = { command: 'Remove-Item "D:\\work\\$other" -Force' };
  assert.equal((await ctx.pre(callAs('s-4', 'pwsh', other), next)).kind, 'deny');
});

test('dry run: a path held in a variable is named, so the first attempt is a card', async () => {
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  const victim = join(work, 'named.txt');
  writeFileSync(victim, 'x', 'utf8');
  writePolicy(dryRunPolicy());
  const ctx = fakeCtx();

  // The literal is in the command; a dry run here would ask for a listing of a
  // path the card can already show (live finding, 2026-11-17).
  const decision = await ctx.pre(
    callAs('s-6', 'pwsh', { command: `$p = '${victim}'\nRemove-Item -LiteralPath $p -Force` }),
    next,
  );
  assert.equal(decision.kind, 'ask');
  assert.ok(decision.displayReason.zh.includes('named.txt'), decision.displayReason.zh);

  const requested = auditLines().filter((r) => r.sessionId === 's-6').find((r) => r.event === 'requested');
  assert.equal(requested.facts.target, victim);
  assert.equal(requested.facts.dryRun, undefined);
});

test('dry run: the refusal is audited as a deny with facts.dryRun=required', async () => {
  writePolicy(dryRunPolicy());
  const ctx = fakeCtx();
  await ctx.pre(callAs('s-5', 'pwsh', OPAQUE), next);
  const mine = auditLines().filter((r) => r.sessionId === 's-5');
  const requested = mine.find((r) => r.event === 'requested');
  assert.ok(requested, JSON.stringify(mine));
  assert.equal(requested.rule, 'R2');
  assert.equal(requested.mode, 'deny');
  assert.equal(requested.facts.dryRun, 'required');
  const outcome = mine.find((r) => r.event === 'outcome');
  assert.equal(outcome.outcome, 'denied');
  assert.equal(outcome.source, 'guardrail');
});

// --- P3: engine v2 ----------------------------------------------------------

function v2Policy(extra = {}) {
  return { version: 2, enabled: true, auditDir: join(dir, 'audit'), ...extra };
}

test('v2 entry deny: refusal is audited as rule E with its entryId', async () => {
  rmSync(join(dir, 'audit'), { recursive: true, force: true });
  writePolicy(v2Policy({
    entries: [{ id: 'no-dist-delete', tool: ['pwsh'], mode: 'deny', when: { commandMatches: '^\\s*Remove-Item\\b' } }],
  }));
  const ctx = fakeCtx();
  const decision = await ctx.pre(callAs('sv-1', 'pwsh', { command: 'Remove-Item -Recurse D:\\work\\dist' }, 'cv1'), next);
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.info.code, 'E');
  const record = auditLines().find((r) => r.callId === 'cv1' && r.event === 'requested');
  assert.ok(record, JSON.stringify(auditLines()));
  assert.equal(record.rule, 'E');
  assert.equal(record.entryId, 'no-dist-delete');
  assert.ok(Array.isArray(record.reasons) && record.reasons.some((reason) => reason.rule === 'E'));
});

test('v2: more than eight matches keep the count in the record', async () => {
  rmSync(join(dir, 'audit'), { recursive: true, force: true });
  writePolicy(v2Policy({
    entries: Array.from({ length: 10 }, (_, index) => ({
      id: `watch-${index}`,
      tool: ['pwsh'],
      mode: 'observe',
      when: { commandMatches: '^\\s*Remove-Item\\b' },
    })),
  }));
  const ctx = fakeCtx();
  await ctx.pre(callAs('sv-3', 'pwsh', { command: 'Remove-Item -Recurse D:\\work\\dist' }, 'cv3'), next);
  const record = auditLines().find((r) => r.callId === 'cv3' && r.event === 'requested');
  assert.ok(record, JSON.stringify(auditLines()));
  assert.equal(record.reasons.length, 8);
  assert.equal(record.reasonsTruncated, true);
});

test('v2 entry ask: the card says the rule in words, the record keeps the id', async () => {
  writePolicy(v2Policy({
    entries: [{ id: 'review-npm-install', tool: ['pwsh'], mode: 'ask', when: { commandMatches: '^\\s*npm (install|ci)\\b' } }],
  }));
  const ctx = fakeCtx();
  const decision = await ctx.pre(callAs('sv-2', 'pwsh', { command: 'npm install' }, 'cv2'), next);
  assert.equal(decision.kind, 'ask');
  assert.match(decision.displayReason.zh, /自定义规则 review-npm-install 要求确认/);
  assert.match(decision.displayReason.en, /Custom rule review-npm-install needs approval/);
});

test('v2 observe: the call passes, is recorded as observed, and shows no card', async () => {
  rmSync(join(dir, 'audit'), { recursive: true, force: true });
  writePolicy(v2Policy({ rules: { destructive: { mode: 'observe' } } }));
  const ctx = fakeCtx();
  const decision = await ctx.pre(callAs('sv-3', 'pwsh', { command: 'Remove-Item -Recurse D:\\work\\dist' }, 'cv3'), next);
  assert.equal(decision.kind, 'allow');
  const record = auditLines().find((r) => r.callId === 'cv3');
  assert.equal(record.event, 'observed');
  assert.equal(record.mode, 'observe');
  assert.equal(record.rule, 'R2');
  assert.ok(record.payloadRef.startsWith('payload/'));
});

test('v2 observed secret: stored with the secret run replaced', async () => {
  rmSync(join(dir, 'audit'), { recursive: true, force: true });
  writePolicy(v2Policy({ rules: { secrets: { mode: 'observe' } } }));
  const ctx = fakeCtx();
  const token = 'sk-proj-abcdefghijklmnopqrstuvwx';
  const decision = await ctx.pre(
    callAs('sv-4', 'write', { file_path: 'D:\\work\\cfg.txt', content: `key=${token}` }, 'cv4'),
    next,
  );
  assert.equal(decision.kind, 'allow');
  const record = auditLines().find((r) => r.callId === 'cv4');
  assert.equal(record.event, 'observed');
  assert.equal(record.rule, 'R3');
  assert.deepEqual(record.redacted, ['openai']);
  assert.ok(record.payloadRef.startsWith('payload/'), 'the redacted text should be stored');
  const stored = readFileSync(join(dir, 'audit', 'v2', record.payloadRef), 'utf8');
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes('<redacted:openai>'), true);
  // The hash is over the stored (redacted) bytes, never over the original.
  const sha = createHash('sha256').update(Buffer.from(stored, 'utf8')).digest('hex');
  assert.equal(record.payloadSha256, sha);
});

test('v2 observed secret: stores nothing when the re-scan still matches', async () => {
  rmSync(join(dir, 'audit'), { recursive: true, force: true });
  // A policy pattern that also matches the placeholder: redaction cannot be
  // trusted, so the payload is dropped entirely (fail closed).
  writePolicy(v2Policy({ rules: { secrets: { mode: 'observe', patterns: ['redacted'] } } }));
  const ctx = fakeCtx();
  const token = 'sk-proj-abcdefghijklmnopqrstuvwx';
  const decision = await ctx.pre(callAs('sv-4b', 'write', { file_path: 'D:\\work\\cfg.txt', content: `key=${token}` }, 'cv4b'), next);
  assert.equal(decision.kind, 'allow');
  const record = auditLines().find((r) => r.callId === 'cv4b');
  assert.equal(record.payloadRef, null);
  assert.equal(record.payloadSha256, null);
  assert.ok(record.redacted.includes('openai'));
});

test('v2: a secret inside a denied call is neither written nor hashed', async () => {
  rmSync(join(dir, 'audit'), { recursive: true, force: true });
  writePolicy(v2Policy({ rules: { secrets: { mode: 'observe' }, destructive: { mode: 'deny' } } }));
  const ctx = fakeCtx();
  const token = 'sk-proj-abcdefghijklmnopqrstuvwx';
  const decision = await ctx.pre(callAs('sv-5', 'pwsh', { command: `Remove-Item -Force D:\\work\\${token}.txt` }, 'cv5'), next);
  assert.equal(decision.kind, 'deny');
  const record = auditLines().find((r) => r.callId === 'cv5');
  assert.equal(record.rule, 'R2');
  assert.equal(record.payloadRef, null);
  // A hash of the original would be a dictionary oracle for weak secrets.
  assert.equal(record.payloadSha256, null);
  assert.ok(record.payloadBytes > 0);
  for (const file of readdirSync(join(dir, 'audit'), { recursive: true })) {
    const path = join(dir, 'audit', file);
    try {
      assert.ok(!readFileSync(path, 'utf8').includes(token), `${file} leaks the secret`);
    } catch {
      // directories and unreadable entries are not payloads
    }
  }
});

test('v2 allow mode: the call runs and is recorded as allowed', async () => {
  rmSync(join(dir, 'audit'), { recursive: true, force: true });
  writePolicy(v2Policy({ rules: { destructive: { mode: 'allow' } } }));
  const ctx = fakeCtx();
  const decision = await ctx.pre(callAs('sv-6', 'pwsh', { command: 'Remove-Item -Recurse D:\\work\\dist' }, 'cv6'), next);
  assert.equal(decision.kind, 'allow');
  const record = auditLines().find((r) => r.callId === 'cv6');
  assert.equal(record.event, 'allowed');
  assert.equal(record.mode, 'allow');
  assert.ok(Array.isArray(record.reasons));
});


