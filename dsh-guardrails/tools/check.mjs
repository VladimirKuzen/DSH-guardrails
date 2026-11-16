#!/usr/bin/env node
/**
 * `dsh-guardrails check`: put one tool call through the same engine the host
 * uses, and report the decision as an exit code.
 *
 * Why a CLI exists at all: the interesting question ("would this call be
 * stopped?") can otherwise only be answered by performing the call and watching
 * the approval card. That is expensive, and wrong when the call is destructive.
 *
 * Contract (see design/p3-policy-v2.md §4):
 *   0  allow / observe / quiet allow
 *   2  needs approval
 *   3  refused
 *   1  usage error, invalid policy, or internal failure — never "allowed"
 *
 * The CLI must not drift from the runtime, so it calls the same `evaluate()` and
 * the same `applyWorkspaceQuiet()` instead of re-implementing either.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { evaluate } from '../rules.js';
import { collectFacts } from '../lib/facts.js';
import { applyWorkspaceQuiet, factRoots } from '../lib/finalize.js';
import { describeErrors, validatePolicy } from '../lib/policy/validate.js';
import { merge } from '../lib/policy/merge.js';
import { DEFAULTS } from '../index.js';

const EXIT = Object.freeze({ allow: 0, review: 2, block: 3, error: 1 });

const USAGE = `Usage: dsh-guardrails check --tool <name> --args <json> [options]

  --tool <name>       tool name, e.g. pwsh, write, edit, apply_patch
  --args <json>       tool arguments as JSON, or "-" to read them from stdin
  --policy <path>     policy file (default: ~/.dsh/guardrails/policy.json)
  --cwd <path>        working directory for relative paths (default: the
                      current directory — only the CLI may default to it)
  --json              print {decision, exitCode, winner, reasons, facts, ...}
  --validate          only validate the policy file, then exit
  --help              show this text

Exit codes: 0 allow, 2 needs approval, 3 refused, 1 usage or policy error.
`;

/** Wrap the runtime's env shape; the CLI is the one place `process.cwd()` is fine. */
function cliEnv(cwd) {
  return {
    USERPROFILE: process.env.USERPROFILE ?? homedir(),
    HOME: homedir(),
    DSH_HOME: process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh'),
    AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'),
    CWD: cwd,
  };
}

function defaultPolicyPath() {
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh');
  return join(home, 'guardrails', 'policy.json');
}

function parseArgs(argv) {
  const options = { tool: '', args: null, policy: '', cwd: '', json: false, validate: false, help: false };
  const rest = argv[0] === 'check' ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--validate') {
      options.validate = true;
    } else if (arg === '--tool') {
      options.tool = rest[++i] ?? '';
    } else if (arg === '--args') {
      options.args = rest[++i] ?? '';
    } else if (arg === '--policy') {
      options.policy = rest[++i] ?? '';
    } else if (arg === '--cwd') {
      options.cwd = rest[++i] ?? '';
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function readPolicyText(path) {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/**
 * Load and validate the policy exactly like the host: a file that fails
 * validation is an error here, not a silent fallback (the host keeps its last
 * good policy; a one-shot CLI has no last good policy to keep).
 */
function loadPolicyForCheck({ policy, warn }) {
  const path = policy || process.env.DSH_GUARDRAILS_POLICY || defaultPolicyPath();
  let file;
  try {
    file = readPolicyText(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      warn(`no policy file at ${path}; using built-in defaults`);
      return { policy: merge(DEFAULTS, {}), path: null };
    }
    throw new Error(`${path}: ${error?.message ?? error}`);
  }
  const report = validatePolicy(file);
  if (!report.ok) {
    throw new Error(`${path}: ${describeErrors(report.errors)}`);
  }
  return { policy: merge(DEFAULTS, file), path };
}

/**
 * The three decision words the contract uses, not the engine's internal modes.
 * `observe` is a boundary allow (exit 0): the call proceeds, and only the audit
 * event says it was recorded. Callers that care can read `winner.mode`.
 */
function decisionOf(verdict) {
  if (verdict === null || verdict === undefined) return 'allow';
  if (verdict.mode === 'ask') return 'review';
  if (verdict.mode === 'deny') return 'block';
  return 'allow';
}

export function run(argv, {
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
  stdin = () => readFileSync(0, 'utf8'),
  // Test-only hook: the contract runner replays cases against a fake user home
  // (`C:\Users\Tester`). There is deliberately no CLI flag for this: a flag
  // would let a shell call look like it ran somewhere else.
  env: envOverride = null,
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(`dsh-guardrails check: ${error.message}`);
    stderr(USAGE);
    return EXIT.error;
  }

  if (options.help) {
    stdout(USAGE);
    return EXIT.allow;
  }

  let loaded;
  try {
    loaded = loadPolicyForCheck({ policy: options.policy, warn: stderr });
  } catch (error) {
    stderr(`dsh-guardrails check: ${error.message}`);
    return EXIT.error;
  }

  if (options.validate) {
    if (loaded.path === null) {
      stderr('dsh-guardrails check: no policy file to validate');
      return EXIT.error;
    }
    stdout(`policy ok: ${loaded.path}`);
    return EXIT.allow;
  }

  if (options.tool === '') {
    stderr('dsh-guardrails check: --tool is required');
    stderr(USAGE);
    return EXIT.error;
  }

  let args;
  try {
    const raw = options.args === '-' ? stdin() : (options.args ?? '{}');
    args = JSON.parse(raw);
  } catch (error) {
    stderr(`dsh-guardrails check: --args must be JSON: ${error.message}`);
    return EXIT.error;
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    stderr('dsh-guardrails check: --args must be a JSON object');
    return EXIT.error;
  }

  const cwd = options.cwd || process.cwd();
  const env = { ...cliEnv(cwd), ...(envOverride ?? {}), CWD: cwd };
  const call = { name: options.tool, arguments: args };
  let verdict;
  try {
    verdict = evaluate(loaded.policy, call, env);
  } catch (error) {
    stderr(`dsh-guardrails check: evaluation failed: ${error?.message ?? error}`);
    return EXIT.error;
  }

  let facts = null;
  try {
    facts = collectFacts(call, verdict, { ...process.env, ...env }, { roots: factRoots(loaded.policy, env) });
  } catch {
    facts = null;
  }

  const quieted = applyWorkspaceQuiet({ policy: loaded.policy, call, verdict, facts, cwd });
  verdict = quieted.verdict;

  const decision = decisionOf(verdict);
  const exitCode = EXIT[decision] ?? EXIT.error;

  if (options.json) {
    stdout(JSON.stringify({
      decision,
      exitCode,
      winner: verdict === null ? null : {
        rule: verdict.rule,
        mode: verdict.mode,
        ...(verdict.sub === undefined ? {} : { sub: verdict.sub }),
        ...(verdict.severity === undefined ? {} : { severity: verdict.severity }),
        ...(verdict.entryId === undefined ? {} : { entryId: verdict.entryId }),
        ...(verdict.quiet === undefined ? {} : { quiet: verdict.quiet }),
      },
      reasons: verdict?.reasons ?? null,
      policyVersion: verdict?.policyVersion ?? (loaded.policy.version === 2 ? 2 : 1),
      facts,
      cwd,
    }, null, 2));
  } else {
    const winner = verdict === null
      ? 'no rule matched'
      : `${verdict.rule} ${verdict.mode}${verdict.sub === undefined ? '' : ` ${verdict.sub}`}`;
    stdout(`${decision}  ${winner}`);
    if (verdict?.reason) stdout(`  ${verdict.reason}`);
  }

  return exitCode;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = run(process.argv.slice(2));
}
