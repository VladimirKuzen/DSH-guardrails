import test from 'node:test';
import assert from 'node:assert/strict';

import { dryRunMessage, dryRunRequirement, destructiveStatements, fingerprint } from '../lib/dry-run.js';

const facts = (over = {}) => ({ tool: 'pwsh', kind: 'delete', target: 'D:\\work\\a.txt', ...over });
const config = { enabled: true, minChars: 400, minStatements: 3, dynamicTarget: true };

test('disabled by default: no requirement', () => {
  assert.equal(dryRunRequirement({ tool: 'pwsh', command: 'Remove-Item "D:\\work\\$p"', facts: facts({ target: '' }), config: {} }), null);
});

test('a target the card cannot name triggers the dry run', () => {
  const requirement = dryRunRequirement({ tool: 'pwsh', command: 'Remove-Item "D:\\work\\$p" -Force', facts: facts({ target: '' }), config });
  assert.equal(requirement.trigger, 'dynamic-target');
});

test('dynamicTarget can be turned off; the other triggers stay', () => {
  const off = { ...config, dynamicTarget: false };
  assert.equal(dryRunRequirement({ tool: 'pwsh', command: 'Remove-Item "D:\\work\\$p" -Force', facts: facts({ target: '' }), config: off }), null);
  const long = `Remove-Item "${'D:\\work\\a.txt;'.repeat(40)}"`;
  assert.equal(dryRunRequirement({ tool: 'pwsh', command: long, facts: facts(), config: off }).trigger, 'long');
});

test('a long command triggers on length', () => {
  const command = `Remove-Item "${'x'.repeat(500)}" -Force`;
  const requirement = dryRunRequirement({ tool: 'pwsh', command, facts: facts(), config });
  assert.equal(requirement.trigger, 'long');
  assert.ok(requirement.chars > 400);
});

test('many destructive steps trigger even when the command is short', () => {
  const command = 'Remove-Item a.txt; Move-Item b.txt c.txt; Remove-Item d.txt';
  const requirement = dryRunRequirement({ tool: 'pwsh', command, facts: facts(), config });
  assert.equal(requirement.trigger, 'many');
  assert.equal(requirement.statements, 3);
});

test('benign kinds and path tools never trigger', () => {
  assert.equal(dryRunRequirement({ tool: 'pwsh', command: 'Get-ChildItem .', facts: facts({ kind: 'unknown' }), config }), null);
  assert.equal(dryRunRequirement({ tool: 'write', command: '', facts: facts({ kind: 'delete', target: '' }), config }), null);
});

test('missing facts are tolerated', () => {
  assert.equal(dryRunRequirement({ tool: 'pwsh', command: 'Remove-Item x', facts: null, config }), null);
});

test('statement counting only counts the destructive ones', () => {
  assert.equal(destructiveStatements('Remove-Item a.txt'), 1);
  assert.equal(destructiveStatements('Remove-Item a.txt && Remove-Item b.txt'), 2);
  assert.equal(destructiveStatements('Get-ChildItem . | Remove-Item'), 1);
  assert.equal(destructiveStatements('Get-ChildItem .'), 0);
  assert.equal(destructiveStatements('git status'), 0);
});

test('the fingerprint is stable and shape-specific', () => {
  assert.equal(fingerprint('pwsh', 'Remove-Item a.txt'), fingerprint('pwsh', 'Remove-Item a.txt'));
  assert.notEqual(fingerprint('pwsh', 'Remove-Item a.txt'), fingerprint('pwsh', 'Remove-Item b.txt'));
  assert.equal(fingerprint('pwsh', 'x').length, 16);
});

test('the refusal says what to do and that it is not a safety verdict', () => {
  const message = dryRunMessage({ trigger: 'dynamic-target', chars: 40, statements: 1 });
  assert.match(message, /dry run/);
  assert.match(message, /read-only listing/);
  assert.match(message, /not judged unsafe/);
  const long = dryRunMessage({ trigger: 'long', chars: 900, statements: 1 });
  assert.match(long, /900 characters/);
  const many = dryRunMessage({ trigger: 'many', chars: 50, statements: 4 });
  assert.match(many, /4 destructive steps/);
});
