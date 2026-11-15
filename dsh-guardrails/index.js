/**
 * dsh-guardrails — turns the three red lines into a global environment.
 * dsh-guardrails —— 把三条红线做成"全局环境"。
 *
 * R1 keeps writes out of DSH's own home, R2 asks before destructive shell
 * operations, R3 keeps secrets out of the conversation.
 *   R1 不碰 DSH 自身目录     R2 破坏性操作先 dry-run     R3 密钥不进对话
 *
 * It listens on the `tools/pre-execute` waterfall and decides every tool call.
 * A hit returns `ask` (one-time approval) or `deny` (refused), and the audit log
 * records who/what/when — labels only, never the secret itself.
 * 实现方式：监听 `tools/pre-execute` 瀑布，对每次工具调用判定一次。
 * 命中红线时返回 `ask`（弹出审批，单次放行）或 `deny`（直接拒绝），
 * 并把"谁、哪条红线、什么时候"写进审计日志——只记标签，绝不记密钥原文。
 *
 * Since 1.3.0 the audit is an event stream (audit/v2): `requested` at the gate,
 * `delivered` when the approval service accepts the question, `outcome` when the
 * user or the guard decides, `executed` when an approved call really ran.
 * 自 1.3.0 起审计改为事件流（audit/v2）：闸门处写 `requested`，审批服务接手时写
 * `delivered`，用户或护栏作出决定时写 `outcome`，批准后真正执行完写 `executed`。
 *
 * Every internal error allows the call (fail-open): the guard must not break the
 * tool chain. The one exception is the critical tier — a shell call that still
 * matches a dangerous pattern is refused when evaluation itself throws
 * (fail-closed), see the catch branch below.
 * 任何内部异常都放行（fail-open）：护栏不能把工具链搞死。唯一的例外是
 * critical 层——判定本身抛异常时，仍然命中危险模式的 shell 调用会被拒绝
 * （fail-closed），见下面的 catch 分支。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { criticalFallback, evaluate } from './rules.js';
import { SHELL_TOOLS } from './lib/rules/kit.js';
import { decideQuiet } from './lib/rules/quiet.js';
import { collectFacts } from './lib/facts.js';
import { describe } from './lib/describe.js';
import { AuditLog, escapeControl, truncateCodePoints } from './lib/audit/v2.js';

export const name = 'guardrails';
export const inject = ['tools'];

/** Single source of truth for the heartbeat version. */
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

const DEFAULTS = {
  enabled: true,
  audit: { format: 'v2', maxPayloadBytes: 64 * 1024 },
  rules: {
    protectDshHome: { mode: 'ask', roots: ['~/.dsh', '~/.agents'], alwaysAskTools: ['plugin_manager'] },
    critical: { mode: 'deny', patterns: [], failClosed: true },
    destructive: { mode: 'ask', patterns: [] },
    secrets: { mode: 'ask', patterns: [] },
  },
};

/** How long an unanswered `requested` stays in the in-memory pending table. */
const PENDING_TTL_MS = 10 * 60 * 1000;
/** `target` is presentation text; 300 code points is plenty and stays readable. */
const MAX_TARGET = 300;

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh');
}

function envForRules() {
  return {
    USERPROFILE: process.env.USERPROFILE ?? homedir(),
    HOME: homedir(),
    DSH_HOME: dshHome(),
    AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'),
  };
}

/** Deep merge: matching keys in the file override defaults; missing keys keep theirs. */
function merge(base, override) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base && base[key] !== null && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? merge(base[key], value)
      : value;
  }
  return out;
}

function readPolicyFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** v1 writer, kept for `audit.format: "v1"`. Never writes the secret itself. */
function auditV1(dir, record) {
  try {
    mkdirSync(dir, { recursive: true });
    const at = new Date(record.ts);
    const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    appendFileSync(join(dir, `audit-${day}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // A failed audit write must not break the main flow
  }
}

function summarize(exec) {
  const args = exec?.arguments ?? {};
  if (typeof args.file_path === 'string') return args.file_path;
  if (typeof args.path === 'string') return args.path;
  const command = typeof args.command === 'string' ? args.command : '';
  return command === '' ? '' : command.length > 120 ? `${command.slice(0, 120)}…` : command;
}

/** Presentation target for the audit: code-point truncation, controls escaped. */
function auditTarget(exec, verdict) {
  if (verdict.rule === 'R3') {
    const filePath = typeof exec?.arguments?.file_path === 'string' ? exec.arguments.file_path : '';
    if (filePath !== '') return truncateCodePoints(escapeControl(filePath), MAX_TARGET).text;
    return null;
  }
  const raw = summarize(exec);
  return raw === '' ? null : truncateCodePoints(escapeControl(raw), MAX_TARGET).text;
}

/** Full text of the operation; R3 stores no payload, only its hash. */
function payloadOf(exec, verdict) {
  const args = exec?.arguments ?? {};
  const text = typeof args.command === 'string' ? args.command : JSON.stringify(args, null, 2);
  return { payload: text, secret: verdict.rule === 'R3' };
}

export function apply(ctx, config = {}) {
  const home = dshHome();
  const policyPath = config.policyPath
    ?? process.env.DSH_GUARDRAILS_POLICY
    ?? join(home, 'guardrails', 'policy.json');

  /** Rewrite the liveness marker; called on mount and on every audited call. */
  const heartbeat = () => {
    try {
      mkdirSync(join(home, 'guardrails'), { recursive: true });
      writeFileSync(join(home, 'guardrails', 'loaded.json'), `${JSON.stringify({
        at: new Date().toISOString(),
        version: VERSION,
        policyPath,
        pid: process.pid,
      }, null, 2)}\n`, 'utf8');
    } catch {
      // A failed heartbeat must not affect the gate.
    }
  };

  let cache = { at: 0, mtime: -1, policy: merge(DEFAULTS, config.policy ?? {}) };

  const loadPolicy = () => {
    const now = Date.now();
    if (now - cache.at < 2_000) return cache.policy;
    cache.at = now;
    let mtime = -1;
    try {
      mtime = statSync(policyPath).mtimeMs;
    } catch {
      cache = { at: now, mtime: -1, policy: merge(DEFAULTS, config.policy ?? {}) };
      return cache.policy;
    }
    if (mtime === cache.mtime) return cache.policy;
    try {
      const file = readPolicyFile(policyPath);
      cache = { at: now, mtime, policy: merge(DEFAULTS, file ?? config.policy ?? {}) };
    } catch {
      // A corrupt policy file keeps the last good copy; the guard must not vanish
    }
    return cache.policy;
  };

  const auditDir = () => {
    const policy = loadPolicy();
    const configured = typeof policy.auditDir === 'string' ? policy.auditDir : '';
    if (configured === '') return join(home, 'guardrails', 'audit');
    return configured
      .replace(/^~(?=$|[\\/])/, homedir())
      .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, key) => process.env[key] ?? '');
  };

  /** True when the event stream is the configured audit format. */
  const usesV2 = () => loadPolicy().audit?.format !== 'v1';

  let log = null;
  const auditLog = () => {
    if (log === null) {
      const maxPayloadBytes = loadPolicy().audit?.maxPayloadBytes;
      log = new AuditLog({
        dir: join(auditDir(), 'v2'),
        ...(Number.isInteger(maxPayloadBytes) && maxPayloadBytes > 0 ? { maxPayloadBytes } : {}),
      });
    }
    return log;
  };

  /** Write one v2 record; a failed audit write must never change the verdict. */
  const emit = (input) => {
    if (!usesV2()) return;
    try {
      auditLog().append(input);
    } catch {
      // fail-open on audit I/O
    }
  };

  // callId -> pending operation, so approval/asked can be matched back to the gate.
  const pending = new Map();
  const byApproval = new Map();
  /** Reasons already reported as config-invalid; one warning per process. */
  const quietWarned = new Set();

  const forget = (entry) => {
    pending.delete(entry.callId);
    if (entry.approvalRequestId !== undefined) byApproval.delete(entry.approvalRequestId);
  };

  const prunePending = () => {
    const now = Date.now();
    for (const entry of [...pending.values()]) {
      if (now - entry.at > PENDING_TTL_MS) forget(entry);
    }
  };

  /**
   * Where the call was aimed. A session without `cwd` is common, and the host
   * process directory is not the workspace — so fall back to the shell tool's
   * explicit `workdir` argument, and otherwise record nothing rather than a
   * value the reader would misread.
   */
  const resolveCwd = (exec) => {
    const sessionCwd = exec?.agent?.session?.cwd;
    if (typeof sessionCwd === 'string' && sessionCwd !== '') {
      return { cwd: sessionCwd, cwdSource: 'session' };
    }
    const workdir = exec?.arguments?.workdir;
    if (SHELL_TOOLS.has(exec?.name) && typeof workdir === 'string' && workdir.trim() !== '') {
      return { cwd: workdir, cwdSource: 'tool' };
    }
    return { cwd: null, cwdSource: null };
  };

  const fieldsFor = (exec, verdict, facts, displayReason) => ({
    sessionId: exec?.agent?.session?.id ?? null,
    ...resolveCwd(exec),
    tool: exec?.name ?? '?',
    callId: exec?.callId ?? null,
    rule: verdict.rule,
    mode: verdict.mode,
    ...(verdict.severity === undefined ? {} : { severity: verdict.severity }),
    target: auditTarget(exec, verdict),
    facts: facts ?? null,
    displayReason: displayReason ?? null,
    localeAtDecision: process.env.DSH_LOCALE ?? null,
  });

  /** `requested` + `outcome` for calls the guard refuses without a card. */
  const recordRefusal = (exec, verdict, fields) => {
    const id = randomUUID();
    const payload = payloadOf(exec, verdict);
    emit({ id, event: 'requested', ...fields, delivered: false, ...payload });
    emit({ id, event: 'outcome', ...fields, outcome: 'denied', source: 'guardrail' });
    return id;
  };

  ctx.on('tools/pre-execute', async (exec, next) => {
    let verdict;
    let policy;
    try {
      policy = loadPolicy();
      if (policy.enabled === false) return next();
      verdict = evaluate(policy, { name: exec?.name, arguments: exec?.arguments }, envForRules());
    } catch {
      // The critical tier fails closed: if evaluation itself broke, a shell call
      // that still matches the critical matcher is refused instead of executed.
      try {
        const fallback = criticalFallback(
          policy ?? { rules: { critical: { mode: 'deny' } } },
          { name: exec?.name, arguments: exec?.arguments },
          envForRules(),
        );
        if (fallback !== null) {
          const fallbackFields = {
            sessionId: exec?.agent?.session?.id ?? null,
            ...resolveCwd(exec),
            tool: exec?.name ?? '?',
            callId: exec?.callId ?? null,
            rule: fallback.rule,
            mode: fallback.mode,
            ...(fallback.severity === undefined ? {} : { severity: fallback.severity }),
            target: truncateCodePoints(escapeControl(summarize(exec)), MAX_TARGET).text,
            facts: null,
            displayReason: null,
            localeAtDecision: process.env.DSH_LOCALE ?? null,
          };
          try {
            auditV1(auditDir(), {
              ts: new Date().toISOString(),
              rule: fallback.rule,
              mode: fallback.mode,
              severity: fallback.severity,
              tool: exec?.name ?? '?',
              decision: 'denied',
              target: summarize(exec),
            });
          } catch {
            // A failed audit write must not cancel the refusal
          }
          recordRefusal(exec, fallback, fallbackFields);
          heartbeat();
          return { kind: 'deny', reason: fallback.reason, info: { name: 'GuardrailsDenied', code: fallback.rule } };
        }
      } catch {
        // Fallback itself failed: keep the original fail-open behaviour.
      }
      return next();
    }
    if (verdict === null) return next();

    let facts = null;
    let displayReason;
    try {
      const roots = policy.rules?.protectDshHome?.roots ?? ['~/.dsh', '~/.agents'];
      facts = collectFacts(exec, verdict, { ...process.env, ...envForRules() }, { roots });
      displayReason = describe(verdict, facts);
    } catch {
      displayReason = undefined;
    }

    // P1.7 workspace quiet: only turns an ordinary "clean up a temp file" ask
    // into an allow. R1, R3, critical and every other R2 hit are untouched.
    if (verdict.mode === 'ask' && verdict.rule === 'R2' && verdict.severity === undefined) {
      const quietConfig = policy.rules?.destructive?.workspaceQuiet;
      const decision = decideQuiet({
        tool: exec?.name,
        command: exec?.arguments?.command,
        facts,
        config: quietConfig,
        cwd: resolveCwd(exec).cwd,
      });
      if (decision.quiet) {
        verdict = { ...verdict, mode: 'allow', quiet: 'workspace' };
      } else if (decision.reason === 'config-invalid' || decision.reason === 'cwd-mismatch') {
        // Misconfiguration disables quiet globally; report it once per process.
        if (!quietWarned.has(decision.reason) && usesV2()) {
          quietWarned.add(decision.reason);
          try {
            auditLog().append({
              id: randomUUID(),
              event: 'config-invalid',
              ts: new Date().toISOString(),
              tool: exec?.name ?? null,
              reason: decision.reason,
            });
          } catch {
            // A failed audit write must not break the tool chain
          }
        }
      }
    }

    const fields = fieldsFor(exec, verdict, facts, displayReason);

    if (verdict.mode === 'allow') {
      if (usesV2()) {
        emit({ id: randomUUID(), event: 'allowed', ...fields, quiet: verdict.quiet ?? null, ...payloadOf(exec, verdict) });
      } else {
        try {
          auditV1(auditDir(), {
            ts: new Date().toISOString(),
            rule: verdict.rule,
            mode: verdict.mode,
            tool: exec?.name ?? '?',
            decision: 'allowed',
            quiet: verdict.quiet,
            target: summarize(exec),
          });
        } catch {
          // A failed audit write must not change the verdict
        }
      }
      return next();
    }

    if (usesV2()) {
      if (verdict.mode === 'deny') {
        recordRefusal(exec, verdict, fields);
      } else {
        prunePending();
        const id = randomUUID();
        if (exec?.callId !== undefined) {
          pending.set(exec.callId, { id, at: Date.now(), callId: exec.callId, approvalRequestId: undefined, approvalOutcome: undefined, fields });
        }
        emit({ id, event: 'requested', ...fields, delivered: false, ...payloadOf(exec, verdict) });
      }
    } else {
      try {
        auditV1(auditDir(), {
          ts: new Date().toISOString(),
          rule: verdict.rule,
          mode: verdict.mode,
          ...(verdict.severity === undefined ? {} : { severity: verdict.severity }),
          tool: exec?.name ?? '?',
          decision: verdict.mode === 'deny' ? 'denied' : 'asked',
          ...(verdict.label === undefined ? {} : { label: verdict.label }),
          // R3 logs the label only, never the value; R1/R2 log the target path or
          // command prefix so a hit can be traced later.
          ...(verdict.rule === 'R3' ? {} : { target: summarize(exec) }),
        });
      } catch {
        // A failed audit write must not change the verdict
      }
    }
    heartbeat();

    if (verdict.mode === 'deny') {
      return { kind: 'deny', reason: verdict.reason, info: { name: 'GuardrailsDenied', code: verdict.rule } };
    }

    return {
      kind: 'ask',
      reason: verdict.reason,
      ...(displayReason === undefined ? {} : { displayReason }),
    };
  });

  // The approval service appends these two session events; `asked` carries the
  // callId, which is the only stable link back to the gate's pending entry.
  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type;
      const data = event?.data ?? {};
      if (type === 'approval/asked') {
        const entry = typeof data.callId === 'string' ? pending.get(data.callId) : undefined;
        if (entry === undefined) return;
        entry.approvalRequestId = data.id;
        byApproval.set(data.id, entry);
        emit({ id: entry.id, event: 'delivered', ...entry.fields, approvalRequestId: data.id, deliveredAt: new Date().toISOString() });
      } else if (type === 'approval/decided') {
        const entry = byApproval.get(data.id);
        if (entry === undefined) return;
        entry.approvalOutcome = data.outcome;
        emit({
          id: entry.id,
          event: 'outcome',
          ...entry.fields,
          outcome: data.outcome,
          source: 'user',
          approvalRequestId: entry.approvalRequestId,
        });
      }
    } catch {
      // Observers must never disturb the session append
    }
  });

  // A denial also reaches post-execute (as an error result), so only an
  // `allowed-once` outcome followed by this hook proves the body really ran.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const entry = exec?.callId !== undefined ? pending.get(exec.callId) : undefined;
      if (entry !== undefined) {
        if (entry.approvalOutcome === 'allowed-once') {
          emit({
            id: entry.id,
            event: 'executed',
            ...entry.fields,
            isError: Boolean(result?.isError),
            errorCode: result?.error?.info?.code ?? result?.error?.code ?? null,
          });
        }
        forget(entry);
      }
    } catch {
      // Never change the tool result
    }
    return next();
  });

  ctx.logger?.info?.(`guardrails: policy at ${policyPath}, audit at ${auditDir()}`);
  heartbeat();
}
