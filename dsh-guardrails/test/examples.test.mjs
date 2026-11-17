import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { validatePolicy } from '../lib/policy/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', 'examples', 'policy');
const names = readdirSync(examples).filter((name) => name.endsWith('.json')).sort();

const load = (name) => JSON.parse(readFileSync(join(examples, name), 'utf8'));

test('examples: every template parses and passes the policy validator', () => {
  assert.ok(names.length >= 4, 'expected the shipped templates');
  for (const name of names) {
    const policy = load(name);
    const result = validatePolicy(policy);
    assert.equal(result.ok, true, `${name}: ${result.errors.map((e) => `${e.code} at ${e.path}`).join(', ')}`);
  }
});

test('examples: the editor hint points at a file that exists', () => {
  for (const name of names) {
    const { $schema: pointer } = load(name);
    assert.equal(typeof pointer, 'string', `${name} has no $schema`);
    const target = resolve(examples, pointer);
    assert.equal(existsSync(target), true, `${name} points at ${target}`);
    assert.equal(target, resolve(here, '..', 'policy.schema.json'));
  }
});

test('examples: entries only appear in version 2 templates', () => {
  for (const name of names) {
    const policy = load(name);
    if (policy.entries === undefined) continue;
    assert.equal(policy.version, 2, `${name} uses entries under version ${policy.version}`);
  }
});

test('examples: the set covers the three stances, and only one relaxes a block', () => {
  const byName = Object.fromEntries(names.map((name) => [name, load(name)]));
  assert.ok(byName['minimal-v1.json'], 'a smallest working file is shipped');
  assert.equal(byName['minimal-v1.json'].version, 1);

  const observing = byName['observe-first.json'].entries.filter((entry) => entry.mode === 'observe');
  assert.ok(observing.length > 0, 'the observe template actually observes something');
  assert.equal(byName['observe-first.json'].rules.destructive.mode, 'ask');

  const tightened = byName['tighten.json'].entries.filter((entry) => entry.mode === 'deny');
  assert.ok(tightened.length >= 2, 'the tighten template adds denies');
  assert.equal(byName['tighten.json'].rules.destructive.mode, 'ask');

  const relaxed = byName['relax-with-guard.json'];
  assert.equal(relaxed.rules.destructive.mode, 'observe');
  assert.ok(relaxed.entries.every((entry) => entry.mode === 'deny'), 'a relaxed block must claw something back');
});
