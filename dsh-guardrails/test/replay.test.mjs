import test from 'node:test';
import assert from 'node:assert/strict';

import { collectFacts } from '../lib/facts.js';
import { describe } from '../lib/describe.js';

/**
 * Replays of two real approvals that produced misleading titles:
 *  - 15:55 backup script: target shown as the local variable $bak
 *  - 00:02 helper script: target shown as the whole %TEMP% directory, 500+
 */
const env = {
  USERPROFILE: 'C:\\Users\\Tester',
  HOME: 'C:\\Users\\Tester',
  DSH_HOME: 'C:\\Users\\Tester\\.dsh',
  AGENTS_HOME: 'C:\\Users\\Tester\\.agents',
};

const roots = ['~/.dsh', '~/.agents'];

const io = {
  statSync() {
    const error = new Error('ENOENT');
    error.code = 'ENOENT';
    throw error;
  },
  readdirSync() {
    return [];
  },
};

const verdict = { rule: 'R1', mode: 'ask' };
const title = (command) =>
  describe(verdict, collectFacts({ name: 'pwsh', arguments: { command } }, verdict, env, { io, roots }));

const backupScript = [
  '$root="D:\\work\\guardrails"',
  "$ts=Get-Date -Format 'yyyyMMdd-HHmmss'",
  '$bak=Join-Path $root "_backup\\$ts-constraints"',
  'New-Item -ItemType Directory -Force -Path $bak | Out-Null',
  'Copy-Item "C:\\Users\\Tester\\.dsh\\AGENTS.md" (Join-Path $bak "AGENTS.md") -Force',
  '"backup: $bak"',
].join('\n');

const helperScript = [
  '$node="C:\\Users\\Tester\\.dsh\\dsh-runtimes\\node\\bin\\node.exe"',
  "$tmp=Join-Path $env:TEMP 'sim.mjs'",
  "Set-Content -Path $tmp -Value 'x' -Encoding UTF8",
  '& $node $tmp',
  'Remove-Item $tmp -Force',
].join('\n');

test('replay: the backup script names the protected file, not $bak', () => {
  const text = title(backupScript).zh;
  assert.ok(text.includes('AGENTS.md'), text);
  assert.ok(!text.includes('$bak'), text);
  assert.ok(text.includes('受保护目录'), text);
  assert.ok(text.includes('命令'), text);
});

test('replay: the helper script no longer claims the whole Temp directory', () => {
  const text = title(helperScript).zh;
  assert.ok(!text.includes('Temp'), text);
  assert.ok(!text.includes('500+'), text);
  assert.ok(text.includes('命令'), text);
});

if (process.env.PRINT_TITLES === '1') {
  console.log('backup:', title(backupScript).zh);
  console.log('helper:', title(helperScript).zh);
}
