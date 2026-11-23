import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, sameEntryPath } from '../tools/doctor.mjs';
import { AuditLog } from '../lib/audit/v2.js';

const PACKAGE_NAME = '@vladimirkuzen/dsh-guardrails';
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/** Run doctor against a throwaway home and keep every line it printed. */
function doctor(args, home) {
  const out = [];
  const err = [];
  const code = run(args, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env: { USERPROFILE: join(tmpdir(), 'doctor-user'), DSH_HOME: home },
  });
  return { code, out, err, text: out.join('\n') };
}

/**
 * A home that passes every deterministic check: one installed copy, a matching
 * loaded.json, a valid policy, and (by default) no audit records yet.
 */
function goodHome({ version = '1.5.1', surface = 'ok', policy = { version: 2 } } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'doctor-'));
  const profile = join(home, 'profiles', 'desktop');
  const copy = join(profile, 'node_modules', PACKAGE_NAME);
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version }), 'utf8');
  mkdirSync(join(home, 'guardrails'), { recursive: true });
  writeFileSync(join(home, 'guardrails', 'policy.json'), JSON.stringify(policy), 'utf8');
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: { [PACKAGE_NAME]: 'link:../../guardrails' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', PACKAGE_NAME] } },
  }), 'utf8');
  writeFileSync(join(home, 'guardrails', 'loaded.json'), JSON.stringify({
    at: '2026-11-21T12:00:00.000Z',
    version,
    policyPath: join(home, 'guardrails', 'policy.json'),
    surface,
    ...(surface === 'ok' ? {} : { surfaceProblems: ['ctx.on'] }),
  }), 'utf8');
  return { home, profile };
}

function addAuditRecords(home, count) {
  const log = new AuditLog({ dir: join(home, 'guardrails', 'audit', 'v2') });
  for (let i = 0; i < count; i += 1) log.append({ event: 'requested', tool: 'pwsh' });
  return join(home, 'guardrails', 'audit', 'v2');
}

test('a healthy install passes every deterministic check', () => {
  const { home } = goodHome();
  const { code, text } = doctor(['--profile', 'desktop'], home);
  assert.equal(code, 0);
  assert.match(text, /installed copy/);
  assert.match(text, new RegExp(`${PACKAGE_NAME} 1\\.5\\.1`));
  assert.match(text, /all deterministic checks passed/);
});

test('a loaded.json version behind the package fails', () => {
  const { home, profile } = goodHome({ version: '1.5.0' });
  const installed = JSON.parse(readFileSync(join(profile, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8'));
  installed.version = '1.5.1';
  writeFileSync(join(profile, 'node_modules', PACKAGE_NAME, 'package.json'), JSON.stringify(installed), 'utf8');
  const { code, text } = doctor(['--profile', 'desktop'], home);
  assert.equal(code, 1);
  assert.match(text, /loaded\.json says 1\.5\.0, installed package is 1\.5\.1/);
});

test('a degraded host surface fails even when the version matches', () => {
  const { home } = goodHome({ surface: 'degraded' });
  const { code, text } = doctor(['--profile', 'desktop'], home);
  assert.equal(code, 1);
  assert.match(text, /surface is "degraded"/);
});

test('two dependency entries resolving to the same copy fail', () => {
  const { home, profile } = goodHome();
  const alias = join(profile, 'node_modules', '@vlad', 'guardrails');
  cpSync(join(profile, 'node_modules', PACKAGE_NAME), alias, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
  pkg.dependencies['@vlad/guardrails'] = 'link:../../guardrails';
  writeFileSync(join(profile, 'package.json'), JSON.stringify(pkg), 'utf8');
  const { code, text } = doctor(['--profile', 'desktop'], home);
  assert.equal(code, 1);
  assert.match(text, /2 dependency entries resolve to this plugin/);
});

test('a policy that fails validation fails the check', () => {
  const { home } = goodHome({ policy: { version: 2, rules: { quiet: { enabled: 'yes' } } } });
  const { code, text } = doctor(['--profile', 'desktop'], home);
  assert.equal(code, 1);
  assert.match(text, /quiet\.enabled/);
});

test('a missing policy is a warning, not a failure', () => {
  const { home } = goodHome();
  rmSync(join(home, 'guardrails', 'policy.json'));
  const { code, text } = doctor(['--profile', 'desktop'], home);
  assert.equal(code, 0);
  assert.match(text, /warn\s+policy/);
  assert.match(text, /built-in defaults/);
});

test('a valid audit chain passes and a tampered record fails', () => {
  const { home } = goodHome();
  const dir = addAuditRecords(home, 2);
  assert.equal(doctor(['--profile', 'desktop'], home).code, 0);

  const file = join(dir, readdirSync(dir).find((name) => name.endsWith('.jsonl')));
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const record = JSON.parse(lines[0]);
  record.tool = 'write';
  lines[0] = JSON.stringify(record);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

  const { code, text } = doctor(['--profile', 'desktop'], home);
  assert.equal(code, 1);
  assert.match(text, /audit chain broken at record 0/);
});

test('--deep reports a suspect bundle as a warning without failing', () => {
  const { home, profile } = goodHome();
  const other = join(profile, 'node_modules', 'cc-safety-net');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'cc-safety-net', version: '0.1.0' }), 'utf8');
  writeFileSync(join(other, 'index.js'), "export const hook = 'tools/pre-execute';\n", 'utf8');
  const pkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
  pkg.dsh.profile.bundles.push('cc-safety-net');
  writeFileSync(join(profile, 'package.json'), JSON.stringify(pkg), 'utf8');

  const { code, text } = doctor(['--profile', 'desktop', '--deep'], home);
  assert.equal(code, 0);
  assert.match(text, /suspected: 1 file/);
  assert.match(text, /cc-safety-net/);
});

test('--json prints one machine-readable object', () => {
  const { home } = goodHome();
  const { code, out } = doctor(['--profile', 'desktop', '--json'], home);
  assert.equal(code, 0);
  const report = JSON.parse(out.join('\n'));
  assert.equal(report.ok, true);
  assert.equal(report.profile, 'desktop');
  assert.deepEqual(report.checks.map((check) => check.id), ['install', 'liveness', 'policy', 'audit']);
});

test('an unknown argument is a usage error', () => {
  const { home } = goodHome();
  const { code, err } = doctor(['--nope'], home);
  assert.equal(code, 2);
  assert.match(err.join('\n'), /unknown argument: --nope/);
});

test('treats a junction path and its target as one entry file', { skip: process.platform !== 'win32' }, (t) => {
  const home = mkdtempSync(join(tmpdir(), 'doctor-junction-'));
  try {
    const link = join(home, 'linked-package');
    try {
      symlinkSync(packageRoot, link, 'junction');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        t.skip('creating a junction is not permitted in this environment');
        return;
      }
      throw error;
    }
    assert.equal(sameEntryPath(join(link, 'tools', 'doctor.mjs'), join(packageRoot, 'tools', 'doctor.mjs')), true);
    assert.equal(sameEntryPath(undefined, join(packageRoot, 'tools', 'doctor.mjs')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
