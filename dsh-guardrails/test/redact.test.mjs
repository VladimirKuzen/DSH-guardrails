import assert from 'node:assert/strict';
import test from 'node:test';

import { redactSecrets } from '../lib/redact.js';

const OPENAI = 'sk-not-a-real-key-0123456789abcdef';

test('replaces an OpenAI-shaped token and reports its label', () => {
  const result = redactSecrets(`Set-Content -Value '${OPENAI}' -Path x.txt`);
  assert.equal(result.text.includes(OPENAI), false);
  assert.equal(result.text.includes('<redacted:openai>'), true);
  assert.deepEqual(result.labels, ['openai']);
  assert.equal(result.clean, true);
});

test('replaces every occurrence, not just the first', () => {
  const text = `${OPENAI} and ${OPENAI}`;
  const result = redactSecrets(text);
  assert.equal(result.text.includes(OPENAI), false);
  assert.equal(result.text.split('<redacted:openai>').length - 1, 2);
});

test('covers every built-in shape with its own label', () => {
  const cases = [
    ['ark-12345678-1234-1234-1234-123456789012', 'ark'],
    ['AKIAABCDEFGHIJKLMNOP', 'aws'],
    ['ghp_' + 'a'.repeat(24), 'github'],
    ['AIza' + 'a'.repeat(35), 'google'],
    ['xoxb-' + '1'.repeat(12), 'slack'],
    ['password=hunter2hunter2', 'generic-key'],
    ['Bearer abcdefghijklmnopqrstuvwxyz', 'bearer'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'private-key'],
  ];
  for (const [value, label] of cases) {
    const result = redactSecrets(`x ${value} y`);
    assert.equal(result.text.includes(value), false, `${label}: value survived`);
    assert.equal(result.text.includes(`<redacted:${label}>`), true, `${label}: label missing`);
    assert.equal(result.clean, true, `${label}: re-scan was not clean`);
  }
});

test('replaces a key=value run with one labelled placeholder', () => {
  // The whole run goes, key name included: deciding which part of a match is
  // "only a name" would be a heuristic, and heuristics in a redactor leak.
  const result = redactSecrets('set password=hunter2hunter2 and continue');
  assert.equal(result.text, 'set <redacted:generic-key> and continue');
  assert.equal(result.clean, true);
});

test('redaction is idempotent: the placeholder never matches again', () => {
  const once = redactSecrets(`a ${OPENAI} b`);
  const twice = redactSecrets(once.text);
  assert.equal(twice.text, once.text);
  assert.deepEqual(twice.labels, []);
});

test('applies policy patterns as well as the built-ins', () => {
  const result = redactSecrets('token ZZ-abcdefghijklmnop', ['ZZ-[a-z]{16}']);
  assert.equal(result.text.includes('ZZ-abcdefghijklmnop'), false);
  assert.equal(result.clean, true);
});

test('reports clean:false when a pattern matches its own placeholder', () => {
  // A pattern that also matches `<redacted:` text: the re-scan must catch it and
  // the caller must then store nothing at all.
  const result = redactSecrets(`x ${OPENAI} y`, ['redacted']);
  assert.equal(result.clean, false);
});

test('handles empty and non-string input', () => {
  assert.deepEqual(redactSecrets(''), { text: '', labels: [], clean: true });
  assert.deepEqual(redactSecrets(undefined), { text: '', labels: [], clean: true });
});

test('ignores an invalid policy pattern instead of throwing', () => {
  const result = redactSecrets(`x ${OPENAI}`, ['(unclosed']);
  assert.equal(result.clean, true);
  assert.equal(result.text.includes(OPENAI), false);
});
