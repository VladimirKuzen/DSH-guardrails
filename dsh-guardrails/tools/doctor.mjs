#!/usr/bin/env node
/**
 * `dsh-guardrails doctor`: read-only health check for one DSH profile.
 *
 * Why it exists: "is the gate actually working?" is answered today by watching
 * for an approval card — i.e. by doing something and hoping it gets stopped.
 * The failures that matter are silent: two copies mounted (two cards per call),
 * `loaded.json` left at the old version after an update, a policy that fails
 * validation and falls back to defaults, a reset audit chain. None of them
 * makes an install fail; all of them degrade the gate without saying so.
 *
 * Contract:
 *   0  every deterministic check passed (warnings do not fail)
 *   1  at least one check failed
 *   2  usage error
 *
 * Read-only: never writes policy, audit, or loaded.json. No network.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describeErrors, validatePolicy } from '../lib/policy/validate.js';
import { verifyChain } from '../lib/audit/v2.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const PACKAGE_NAME = PACKAGE.name;

const EXIT = Object.freeze({ ok: 0, problems: 1, usage: 2 });

const USAGE = `Usage: dsh-guardrails doctor [options]

  --profile <name>    profile to inspect (default: desktop)
  --home <path>       DSH home (default: $DSH_HOME, else ~/.dsh)
  --policy <path>     policy file to validate (default: the one in loaded.json)
  --deep              also scan other bundles for tools/pre-execute hooks
                      (heuristic; findings are warnings, not failures)
  --json              print one JSON object instead of the report
  --help              show this text

Checks: duplicate installs, loaded.json vs package version, policy validity,
audit chain. Exit codes: 0 all good, 1 problems, 2 usage error.
`;

function readJson(path) {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function parseArgs(argv) {
  const options = { profile: 'desktop', home: '', policy: '', deep: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--deep') options.deep = true;
    else if (arg === '--profile') options.profile = argv[++i] ?? '';
    else if (arg === '--home') options.home = argv[++i] ?? '';
    else if (arg === '--policy') options.policy = argv[++i] ?? '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.profile === '') throw new Error('--profile needs a name');
  return options;
}

function defaultHome(env) {
  return env.DSH_HOME?.trim() ? env.DSH_HOME.trim() : join(env.USERPROFILE ?? homedir(), '.dsh');
}

/** Read a package.json that may be reached through node_modules or a link: target. */
function packageAt(file) {
  try {
    const data = readJson(file);
    if (typeof data.name !== 'string' || typeof data.version !== 'string') return null;
    return { dir: realpathSync(dirname(file)), name: data.name, version: data.version };
  } catch {
    return null;
  }
}

function resolveDependency(profileDir, name, spec) {
  const direct = packageAt(join(profileDir, 'node_modules', name, 'package.json'));
  if (direct !== null) return direct;
  if (typeof spec === 'string' && spec.startsWith('link:')) {
    return packageAt(join(resolve(profileDir, spec.slice('link:'.length)), 'package.json'));
  }
  return null;
}

/**
 * Two ways to end up mounted twice: two dependency entries resolving to the
 * same source (an alias next to the real name), or two different sources that
 * both claim to be this package (an old npm copy left behind a new link:).
 * Either doubles every card and every audit event.
 */
function checkInstall(profileDir) {
  const problems = [];
  const notes = [];
  let pkg = null;
  try {
    pkg = readJson(join(profileDir, 'package.json'));
  } catch (error) {
    return {
      status: 'fail',
      detail: `cannot read ${join(profileDir, 'package.json')}: ${error?.message ?? error}`,
      problems: ['profile package.json missing or unparsable'],
      notes,
      version: null,
    };
  }

  const deps = pkg?.dependencies ?? {};
  const copies = [];
  for (const [name, spec] of Object.entries(deps)) {
    const resolved = resolveDependency(profileDir, name, spec);
    if (resolved === null) continue;
    if (resolved.name === PACKAGE_NAME || /guardrails/i.test(name)) copies.push({ key: name, spec, ...resolved });
  }

  if (copies.length === 0) {
    problems.push(`no dependency resolves to ${PACKAGE_NAME}`);
    return { status: 'fail', detail: `none of the profile dependencies is ${PACKAGE_NAME}`, problems, notes, version: null };
  }

  const dirs = new Map();
  for (const copy of copies) dirs.set(copy.dir, (dirs.get(copy.dir) ?? []).concat(copy.key));
  if (copies.length > 1) {
    problems.push(`${copies.length} dependency entries resolve to this plugin: ${copies.map((c) => c.key).join(', ')}`);
  }
  for (const [dir, keys] of dirs) {
    if (keys.length > 1) problems.push(`two names point at one copy (${keys.join(', ')}): ${dir}`);
  }

  const bundles = pkg?.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) {
    const mounted = bundles.filter((name) => typeof name === 'string' && /guardrails/i.test(name));
    if (mounted.length > 1) problems.push(`bundles lists this plugin ${mounted.length} times: ${mounted.join(', ')}`);
  }

  const version = copies[0].version;
  const detail = `${PACKAGE_NAME} ${version} (${copies[0].key})`;
  return { status: problems.length === 0 ? 'ok' : 'fail', detail, problems, notes, version };
}

function checkLiveness(home, installedVersion) {
  const file = join(home, 'guardrails', 'loaded.json');
  if (!existsSync(file)) {
    return { status: 'fail', detail: `no ${file}: the host has not mounted the plugin since this file was created`, loaded: null };
  }
  let loaded;
  try {
    loaded = readJson(file);
  } catch (error) {
    return { status: 'fail', detail: `${file} is unreadable: ${error?.message ?? error}`, loaded: null };
  }
  const problems = [];
  if (installedVersion !== null && loaded.version !== installedVersion) {
    problems.push(`loaded.json says ${String(loaded.version)}, installed package is ${installedVersion}`);
  }
  if (loaded.surface !== 'ok') {
    problems.push(`surface is ${JSON.stringify(loaded.surface)}${Array.isArray(loaded.surfaceProblems) ? ` (${loaded.surfaceProblems.join(', ')})` : ''}`);
  }
  return {
    status: problems.length === 0 ? 'ok' : 'fail',
    detail: `loaded.json version ${String(loaded.version)}, surface ${String(loaded.surface)}`,
    problems,
    loaded,
  };
}

function checkPolicy(home, loaded, override) {
  const path = override
    || (typeof loaded?.policyPath === 'string' && loaded.policyPath !== '' ? loaded.policyPath : join(home, 'guardrails', 'policy.json'));
  if (!existsSync(path)) {
    return { status: 'warn', detail: `no policy file at ${path}; the plugin falls back to built-in defaults`, path };
  }
  let file;
  try {
    file = readJson(path);
  } catch (error) {
    return { status: 'fail', detail: `${path}: ${error?.message ?? error}`, path };
  }
  const report = validatePolicy(file);
  if (!report.ok) return { status: 'fail', detail: `${path}: ${describeErrors(report.errors)}`, path };
  return { status: 'ok', detail: `${path} is valid (version ${String(file.version ?? 1)})`, path };
}

function checkAudit(home) {
  const dir = join(home, 'guardrails', 'audit', 'v2');
  if (!existsSync(dir)) return { status: 'ok', detail: `no v2 records under ${dir}`, records: 0 };
  const files = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  const records = [];
  const broken = [];
  for (const name of files) {
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch (error) {
      broken.push(`${name}: ${error?.message ?? error}`);
      continue;
    }
    text.split('\n').forEach((line, index) => {
      if (line.trim() === '') return;
      try {
        records.push(JSON.parse(line));
      } catch {
        broken.push(`${name}:${index + 1}`);
      }
    });
  }
  if (broken.length > 0) {
    return { status: 'fail', detail: `unparsable audit line(s): ${broken.slice(0, 5).join(', ')}`, records: records.length };
  }
  if (records.length === 0) return { status: 'ok', detail: `no v2 records under ${dir}`, records: 0 };
  const result = verifyChain(records);
  if (!result.ok) {
    return {
      status: 'fail',
      detail: `audit chain broken at record ${result.index} (${result.brokenAt ?? '?'}): ${result.reason}`,
      records: records.length,
    };
  }
  return { status: 'ok', detail: `${records.length} record(s) verified`, records: records.length };
}

const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SCAN_MAX_BYTES = 512 * 1024;
const SCAN_MAX_FILES = 3000;

/**
 * Heuristic only: a bundle whose source mentions the hook string is *suspected*
 * of also gating calls. It may be a comment, an unused import, or our own code
 * fetched through a dependency; the report says "suspected" and never fails.
 *
 * @deepseek-ai/* bundles are the host itself: they own the hook chain, so
 * scanning them would only produce noise.
 */
function scanOtherHooks(profileDir, pkg, budgetMs = 2000) {
  const bundles = pkg?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return { scanned: 0, hits: [], unresolved: [], truncated: false };
  const deadline = Date.now() + budgetMs;
  const hits = [];
  const unresolved = [];
  let scanned = 0;
  let truncated = false;

  const walk = (dir, bundle) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (Date.now() > deadline || scanned >= SCAN_MAX_FILES) {
        truncated = true;
        return;
      }
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, bundle);
        continue;
      }
      if (!entry.isFile() || !SCAN_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) continue;
      try {
        if (statSync(full).size > SCAN_MAX_BYTES) continue;
        const text = readFileSync(full, 'utf8');
        if (text.includes('tools/pre-execute') || text.includes('tools/post-execute')) hits.push({ bundle, file: full });
        scanned += 1;
      } catch {
        // Unreadable file: not evidence, skip.
      }
    }
  };

  for (const name of bundles) {
    if (typeof name !== 'string' || name === PACKAGE_NAME || name.startsWith('@deepseek-ai/')) continue;
    const dir = join(profileDir, 'node_modules', name);
    if (!existsSync(dir)) {
      unresolved.push(name);
      continue;
    }
    walk(dir, name);
  }
  return { scanned, hits, unresolved, truncated };
}

function printReport(stdout, report) {
  stdout(`dsh-guardrails doctor ${PACKAGE.version}`);
  stdout(`home: ${report.home}`);
  stdout(`profile: ${report.profile}`);
  stdout('');
  for (const check of report.checks) {
    const tag = check.status === 'ok' ? 'ok  ' : check.status === 'warn' ? 'warn' : 'FAIL';
    stdout(`${tag}  ${check.name.padEnd(18)} ${check.detail}`);
    for (const problem of check.problems ?? []) stdout(`      - ${problem}`);
  }
  if (report.deep) {
    stdout('');
    if (report.deep.hits.length === 0) {
      stdout('ok    other hooks        no other bundle mentions the pre/post-execute hooks');
    } else {
      stdout(`warn  other hooks        suspected: ${report.deep.hits.length} file(s) in other bundles mention the hook`);
      for (const hit of report.deep.hits.slice(0, 10)) stdout(`      ? ${hit.bundle}: ${hit.file}`);
      if (report.deep.hits.length > 10) stdout(`      ? … ${report.deep.hits.length - 10} more`);
    }
    if (report.deep.truncated) stdout('      ? scan hit its time/file budget; the list may be incomplete');
    if (report.deep.unresolved.length > 0) {
      stdout(`      ? could not resolve: ${report.deep.unresolved.join(', ')}`);
    }
  }
  const failed = report.checks.filter((check) => check.status === 'fail').length;
  const warned = report.checks.filter((check) => check.status === 'warn').length;
  stdout('');
  if (failed === 0) {
    stdout(`all deterministic checks passed${warned === 0 ? '' : ` (${warned} warning(s))`}`);
  } else {
    stdout(`${failed} check(s) failed, ${warned} warning(s)`);
  }
}

export function run(argv, {
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
  env = process.env,
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(`dsh-guardrails doctor: ${error.message}`);
    stderr(USAGE);
    return EXIT.usage;
  }
  if (options.help) {
    stdout(USAGE);
    return EXIT.ok;
  }

  const home = options.home !== '' ? resolve(options.home) : resolve(defaultHome(env));
  const profileDir = join(home, 'profiles', options.profile);

  const install = checkInstall(profileDir);
  const liveness = checkLiveness(home, install.version);
  const policy = checkPolicy(home, liveness.loaded, options.policy);
  const audit = checkAudit(home);

  const checks = [
    { id: 'install', name: 'installed copy', status: install.status, detail: install.detail, problems: install.problems },
    { id: 'liveness', name: 'liveness', status: liveness.status, detail: liveness.detail, problems: liveness.problems },
    { id: 'policy', name: 'policy', status: policy.status, detail: policy.detail, problems: policy.problems },
    { id: 'audit', name: 'audit chain', status: audit.status, detail: audit.detail, problems: audit.problems },
  ];

  let deep = null;
  if (options.deep) {
    let pkg = null;
    try {
      pkg = readJson(join(profileDir, 'package.json'));
    } catch {
      pkg = null;
    }
    deep = scanOtherHooks(profileDir, pkg);
  }

  const report = {
    ok: checks.every((check) => check.status !== 'fail'),
    version: PACKAGE.version,
    home,
    profile: options.profile,
    checks,
    ...(deep === null ? {} : { deep }),
  };

  if (options.json) stdout(JSON.stringify(report, null, 2));
  else printReport(stdout, report);

  return report.ok ? EXIT.ok : EXIT.problems;
}

// A profile may reach this file through a junction (`link:` installs on Windows),
// so argv[1] and import.meta.url can be two spellings of one file. Compare
// canonical paths; otherwise the tool would exit 0 without printing anything.
export function sameEntryPath(argvPath, modulePath) {
  if (argvPath === undefined) return false;
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return pathToFileURL(argvPath).href === pathToFileURL(modulePath).href;
  }
}

function isMainEntry() {
  return sameEntryPath(process.argv[1], fileURLToPath(import.meta.url));
}

if (isMainEntry()) {
  process.exitCode = run(process.argv.slice(2));
}
