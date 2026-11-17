import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';

import { evaluate } from '../rules.js';
import { assertSelfRoot, evaluateR1Self, pluginRoot, selfRoots } from '../lib/rules/r1-self.js';
import { collectFacts } from '../lib/facts.js';
import { describe } from '../lib/describe.js';

const env = {
  USERPROFILE: 'C:\\Users\\Tester',
  DSH_HOME: 'C:\\Users\\Tester\\.dsh',
  AGENTS_HOME: 'C:\\Users\\Tester\\.agents',
};

const root = pluginRoot();
const call = (name, args) => ({ name, arguments: args });

/** A policy with only the slice this rule reads, plus the home rule it must not depend on. */
const policy = (selfProtect, home = { mode: 'ask', roots: ['~/.dsh', '~/.agents'] }) => ({
  enabled: true,
  rules: {
    protectDshHome: home,
    destructive: { mode: 'ask' },
    secrets: { mode: 'ask' },
    selfProtect,
  },
});

test('self: the auto root is the plugin checkout itself', () => {
  assert.equal(root.toLowerCase().split('\\').pop(), 'dsh-guardrails');
  assert.doesNotThrow(() => assertSelfRoot(root));
});

test('self: a root that is not the plugin fails the startup assertion', () => {
  assert.throws(() => assertSelfRoot('D:\\work\\Guardrails'), /not a dsh-guardrails directory/);
  assert.throws(() => assertSelfRoot('D:\\work\\dsh-guardrails2'), /not a dsh-guardrails directory/);
});

test('self: write into the plugin source asks', () => {
  const verdict = evaluate(policy({ mode: 'ask', paths: [] }), call('write', {
    file_path: `${root}\\rules.js`,
    content: 'export const evaluate = () => null;',
  }), env);
  assert.equal(verdict?.rule, 'R1');
  assert.equal(verdict?.sub, 'self');
  assert.equal(verdict?.mode, 'ask');
  assert.match(verdict.reason, /own source/);
});

test('self: shell command that writes into the plugin source asks', () => {
  const verdict = evaluate(policy({ mode: 'ask', paths: [] }), call('pwsh', {
    command: `Set-Content "${root}\\rules.js" -Value "x"`,
  }), env);
  assert.equal(verdict?.rule, 'R1');
  assert.equal(verdict?.sub, 'self');
});

test('self: reading the plugin source is not a hit', () => {
  assert.equal(evaluate(policy({ mode: 'ask', paths: [] }), call('pwsh', {
    command: `Get-Content "${root}\\rules.js"`,
  }), env), null);
});

test('self: a path carried by a variable still asks', () => {
  // 真实形状：路径在赋值语句里，写动词在后面的语句里，第一次修 policy.json 就是这么漏的。
  const verdict = evaluate(policy({ mode: 'ask', paths: [] }), call('pwsh', {
    command: `$src = '${root}\\rules.js'; $text = 'x'; Set-Content -LiteralPath $src -Value $text`,
  }), env);
  assert.equal(verdict?.rule, 'R1');
  assert.equal(verdict?.sub, 'self');
});

test('self: File::WriteAllText into the plugin source asks', () => {
  const verdict = evaluate(policy({ mode: 'ask', paths: [] }), call('pwsh', {
    command: `$f = '${root}\\rules.js'; [System.IO.File]::WriteAllText($f, 'x')`,
  }), env);
  assert.equal(verdict?.rule, 'R1');
  assert.equal(verdict?.sub, 'self');
});

test('self: writing next to the plugin, not into it, is not a hit', () => {
  assert.equal(evaluate(policy({ mode: 'ask', paths: [] }), call('write', {
    file_path: 'D:\\work\\notes.md',
    content: 'hi',
  }), env), null);
});

test('self: a sibling directory sharing the prefix is not a hit', () => {
  const sibling = `${root}2`;
  assert.equal(evaluate(policy({ mode: 'ask', paths: [] }), call('pwsh', {
    command: `Set-Content "${sibling}\\rules.js" -Value "x"`,
  }), env), null);
});

test('self: running a file from the plugin is not a write to it', () => {
  // 程序位例外：`& "<root>\run.mjs"` 是执行，不是写入；旁边的 Set-Content 写的是别处。
  assert.equal(evaluate(policy({ mode: 'ask', paths: [] }), call('pwsh', {
    command: `& "${root}\\test\\check.mjs"; Set-Content -LiteralPath "C:\\work\\out.txt" -Value x`,
  }), env), null);
});

test('self: deny refuses instead of asking', () => {
  const verdict = evaluate(policy({ mode: 'deny', paths: [] }), call('write', {
    file_path: `${root}\\index.js`,
    content: 'x',
  }), env);
  assert.equal(verdict?.mode, 'deny');
});

test('self: off and allow are ignored even when a hand-written policy skips validation', () => {
  for (const mode of ['off', 'allow']) {
    assert.equal(evaluateR1Self(call('write', { file_path: `${root}\\rules.js` }), { mode }, env), null);
  }
});

test('self: paths from policy extend the roots and are normalized', () => {
  const extra = ['D:\\work\\vendor\\dsh-guardrails'];
  const verdict = evaluate(policy({ mode: 'ask', paths: extra }), call('pwsh', {
    command: 'Remove-Item D:\\work\\vendor\\dsh-guardrails\\a.js -Force',
  }), env);
  assert.equal(verdict?.sub, 'self');

  // The bare directory itself, without a trailing separator, also counts.
  assert.equal(evaluate(policy({ mode: 'ask', paths: extra }), call('pwsh', {
    command: 'Remove-Item D:\\work\\vendor\\dsh-guardrails -Recurse',
  }), env)?.sub, 'self');
});

test('self: a relative extra root cannot match an unrelated absolute path', () => {
  // evaluate() does not validate; policy validation rejects the relative path,
  // but a hand-written policy must not become a wildcard either.
  const verdict = evaluate(policy({ mode: 'ask', paths: ['..\\dsh-guardrails'] }), call('write', {
    file_path: 'D:\\work\\notes.md',
    content: 'hi',
  }), env);
  assert.equal(verdict, null);
});

test('self: the home rule can be off while self-protection still asks', () => {
  const verdict = evaluate(policy({ mode: 'ask', paths: [] }, { mode: 'off' }), call('write', {
    file_path: `${root}\\lib\\describe.js`,
    content: 'x',
  }), env);
  assert.equal(verdict?.sub, 'self');
});

test('self: roots are deduplicated', () => {
  const roots = selfRoots({ paths: [root, '~/.agents-guardrails'] }, env);
  assert.equal(new Set(roots).size, roots.length);
});

test('self: uppercase spelling of the same path still matches', () => {
  const verdict = evaluate(policy({ mode: 'ask', paths: [] }), call('write', {
    file_path: root.toUpperCase() + '\\RULES.JS',
    content: 'x',
  }), env);
  assert.equal(verdict?.sub, 'self');
});

test('self: apply_patch with only patch text is scanned, not skipped', () => {
  const patch = [
    '*** Begin Patch',
    `*** Update File: ${root}\\rules.js`,
    '@@',
    '-export const evaluate = () => null;',
    '+export const evaluate = () => null; // still here',
    '*** End Patch',
  ].join('\n');
  const verdict = evaluate(policy({ mode: 'ask', paths: [] }), call('apply_patch', { patch }), env);
  assert.equal(verdict?.rule, 'R1');
  assert.equal(verdict?.sub, 'self');
  assert.match(verdict.reason, /patch/);
});

test('self: a patch that only moves a file into the source is scanned too', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: D:\\work\\notes.md',
    `*** Move to: ${root}\\rules.js`,
    '*** End Patch',
  ].join('\n');
  const verdict = evaluate(policy({ mode: 'ask', paths: [] }), call('apply_patch', { patch }), env);
  assert.equal(verdict?.rule, 'R1');
  assert.equal(verdict?.sub, 'self');
});

test('self: a patch outside the protected roots is untouched', () => {
  const patch = ['*** Begin Patch', '*** Update File: D:\\work\\notes.md', '@@', '-a', '+b', '*** End Patch'].join('\n');
  assert.equal(evaluate(policy({ mode: 'ask', paths: [] }), call('apply_patch', { patch }), env), null);
});

test('self: a relative tool path is resolved against the session cwd', () => {
  const relative = call('write', { file_path: 'dsh-guardrails\\rules.js', content: 'x' });
  // The checkout's parent: derived from this file, so the test does not depend on where the repo lives.
  const withCwd = { ...env, CWD: dirname(root) };
  assert.equal(evaluate(policy({ mode: 'ask', paths: [] }), relative, withCwd)?.sub, 'self');
  // Without a known cwd the relative path cannot be placed anywhere, so nothing fires.
  assert.equal(evaluate(policy({ mode: 'ask', paths: [] }), relative, env), null);
});

test('R1 home: a relative tool path is resolved against the session cwd too', () => {
  const relative = call('write', { file_path: '.dsh\\guardrails\\policy.json', content: 'x' });
  const withCwd = { ...env, CWD: env.USERPROFILE };
  const verdict = evaluate(policy({ mode: 'ask', paths: [] }), relative, withCwd);
  assert.equal(verdict?.rule, 'R1');
  assert.equal(verdict?.sub, undefined);
});

test('self: the card copy calls the gate source a protected directory', () => {
  // Merged roots are what index.js hands to collectFacts; without the self roots
  // the card would claim "DSH home" only.
  const target = `${root}\\scratch-not-on-disk.js`;
  const writeCall = call('write', { file_path: target, content: 'x' });
  const verdict = evaluate(policy({ mode: 'ask', paths: [] }), writeCall, env);
  const facts = collectFacts(writeCall, verdict, env, { roots: selfRoots({ paths: [] }, env) });
  assert.equal(facts.protectedHit, true);
  const copy = describe(verdict, facts);
  assert.match(copy.zh, /受保护目录/);
  assert.match(copy.en, /protected directory/);
});
