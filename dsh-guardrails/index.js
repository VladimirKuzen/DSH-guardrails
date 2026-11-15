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
 * Every internal error allows the call (fail-open): the guard must not break the
 * tool chain. The one exception is the critical tier — a shell call that still
 * matches a dangerous pattern is refused when evaluation itself throws
 * (fail-closed), see the catch branch below.
 * 任何内部异常都放行（fail-open）：护栏不能把工具链搞死。唯一的例外是
 * critical 层——判定本身抛异常时，仍然命中危险模式的 shell 调用会被拒绝
 * （fail-closed），见下面的 catch 分支。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { criticalFallback, evaluate } from './rules.js';
import { collectFacts } from './lib/facts.js';
import { describe } from './lib/describe.js';

export const name = 'guardrails';
export const inject = ['tools'];

/** Single source of truth for the heartbeat version. */
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

const DEFAULTS = {
  enabled: true,
  rules: {
    protectDshHome: { mode: 'ask', roots: ['~/.dsh', '~/.agents'], alwaysAskTools: ['plugin_manager'] },
    critical: { mode: 'deny', patterns: [], failClosed: true },
    destructive: { mode: 'ask', patterns: [] },
    secrets: { mode: 'ask', patterns: [] },
  },
};

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

/** Append one hit to the per-day audit file. Never writes the secret itself. */
function audit(dir, record) {
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
          try {
            audit(auditDir(), {
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
          heartbeat();
          return { kind: 'deny', reason: fallback.reason, info: { name: 'GuardrailsDenied', code: fallback.rule } };
        }
      } catch {
        // Fallback itself failed: keep the original fail-open behaviour.
      }
      return next();
    }
    if (verdict === null) return next();

    try {
      audit(auditDir(), {
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
    heartbeat();

    if (verdict.mode === 'deny') {
      return { kind: 'deny', reason: verdict.reason, info: { name: 'GuardrailsDenied', code: verdict.rule } };
    }

    // Presentation copy is built here, at the edge, so rules.js stays pure and
    // without filesystem access. Any failure falls back to the English reason.
    let displayReason;
    try {
      const roots = policy.rules?.protectDshHome?.roots ?? ['~/.dsh', '~/.agents'];
      const facts = collectFacts(exec, verdict, { ...process.env, ...envForRules() }, { roots });
      displayReason = describe(verdict, facts);
    } catch {
      displayReason = undefined;
    }

    return {
      kind: 'ask',
      reason: verdict.reason,
      ...(displayReason === undefined ? {} : { displayReason }),
    };
  });

  ctx.logger?.info?.(`guardrails: policy at ${policyPath}, audit at ${auditDir()}`);
  heartbeat();
}
