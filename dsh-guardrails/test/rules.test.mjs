import test from 'node:test';
import assert from 'node:assert/strict';

import { criticalFallback, evaluate, expandPath, DEFAULT_SECRETS } from '../rules.js';

const env = {
  USERPROFILE: 'C:\\Users\\Tester',
  DSH_HOME: 'C:\\Users\\Tester\\.dsh',
  AGENTS_HOME: 'C:\\Users\\Tester\\.agents',
};

const policy = {
  enabled: true,
  rules: {
    protectDshHome: { mode: 'ask', roots: ['~/.dsh', '~/.agents'] },
    destructive: { mode: 'ask' },
    secrets: { mode: 'ask' },
  },
};

const call = (name, args) => ({ name, arguments: args });
const rules = (v) => v?.rule ?? null;

test('R1: 写入 ~/.dsh 会拦', () => {
  const verdict = evaluate(policy, call('write', {
    file_path: 'C:\\Users\\Tester\\.dsh\\AGENTS.md',
    content: 'hi',
  }), env);
  assert.equal(rules(verdict), 'R1');
  assert.equal(verdict.mode, 'ask');
});

test('R1: 写入工作区放行', () => {
  assert.equal(evaluate(policy, call('write', {
    file_path: 'D:\\work\\notes.md',
    content: 'hi',
  }), env), null);
});

test('R1: ~ 与 %VAR% 都能展开', () => {
  assert.equal(expandPath('~/.dsh/AGENTS.md', env), 'c:\\users\\tester\\.dsh\\agents.md');
  assert.equal(expandPath('%USERPROFILE%\\.dsh\\x', env), 'c:\\users\\tester\\.dsh\\x');
  assert.equal(expandPath('$env:DSH_HOME\\y', env), 'c:\\users\\tester\\.dsh\\y');
});

test('R1: 只读命令不拦', () => {
  assert.equal(evaluate(policy, call('pwsh', {
    command: 'Get-Content $env:USERPROFILE\\.dsh\\AGENTS.md',
  }), env), null);
});

test('R1: shell 写入 .dsh 会拦', () => {
  const verdict = evaluate(policy, call('pwsh', {
    command: 'Set-Content "$env:USERPROFILE\\.dsh\\AGENTS.md" -Value "x"',
  }), env);
  assert.equal(rules(verdict), 'R1');
});

test('R1: 路径经变量转手、写动词在另一条语句里也会拦', () => {
  // 2026-11-17 真实漏掉的形状：路径在赋值语句，Set-Content 在后面的语句。
  const verdict = evaluate(policy, call('pwsh', {
    command: '$p = Join-Path $env:USERPROFILE ".dsh\\guardrails\\policy.json"; $o = "{}"; Set-Content -LiteralPath $p -Value $o',
  }), env);
  assert.equal(rules(verdict), 'R1');
});

test('R1: 执行 ~/.dsh 下的程序不算写入它', () => {
  // 2026-11-17 的误报：命令行里出现 bundled node 的绝对路径，附近的 Set-Content 在写别处。
  for (const command of [
    '& "$env:USERPROFILE\\.dsh\\dsh-runtimes\\node.exe" "C:\\work\\x.mjs"; Set-Content -LiteralPath "C:\\work\\out.txt" -Value x',
    'Start-Process "$env:USERPROFILE\\.dsh\\tools\\probe.exe"; Set-Content -LiteralPath "C:\\work\\o.txt" -Value x',
  ]) {
    assert.equal(evaluate(policy, call('pwsh', { command }), env), null, command);
  }
});

test('R1: 写 ~/.dsh 下的文件仍然拦（程序位例外不放大）', () => {
  const verdict = evaluate(policy, call('pwsh', {
    command: 'Remove-Item -LiteralPath "$env:USERPROFILE\\.dsh\\dsh-runtimes\\node.exe" -Force',
  }), env);
  assert.equal(rules(verdict), 'R1');
});

test('R1: File::WriteAllText 也算写动词', () => {
  const verdict = evaluate(policy, call('pwsh', {
    command: '$p = "$env:USERPROFILE\\.dsh\\guardrails\\policy.json"; [System.IO.File]::WriteAllText($p, "{}")',
  }), env);
  assert.equal(rules(verdict), 'R1');
});

test('R1: plugin_manager 一律拦', () => {
  assert.equal(rules(evaluate(policy, call('plugin_manager', { action: 'list_bundles' }), env)), 'R1');
});

test('R2: 删除与移动会拦', () => {
  assert.equal(rules(evaluate(policy, call('pwsh', { command: 'Remove-Item -Recurse .\\build' }), env)), 'R2');
  assert.equal(rules(evaluate(policy, call('pwsh', { command: 'Move-Item a.txt b.txt' }), env)), 'R2');
  assert.equal(rules(evaluate(policy, call('pwsh', { command: 'git reset --hard HEAD~1' }), env)), 'R2');
});

test('R2: 日常命令放行', () => {
  for (const command of [
    'Get-ChildItem -Force',
    'git status',
    'python price_probe.py --dry-run',
    'git commit -m "rm old files from README"',
    'npm run build',
    'dism /online /cleanup-image /scanhealth',
  ]) {
    assert.equal(evaluate(policy, call('pwsh', { command }), env), null, command);
  }
});

test('R3: 参数里的密钥会拦', () => {
  const verdict = evaluate(policy, call('pwsh', {
    command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" https://example.com',
  }), env);
  assert.equal(rules(verdict), 'R3');
  // 提示里只出现标签，不出现原文
  assert.ok(!JSON.stringify(verdict).includes('abcdefghijklmnopqrstuvwxyz123456'));
});

test('R3: 写文件时正文含密钥也会拦', () => {
  const key = ['ark', '11111111-2222-3333-4444-555555555555'].join('-');
  const verdict = evaluate(policy, call('write', {
    file_path: 'D:\\work\\config.json',
    content: `{"apiKey":"${key}"}`,
  }), env);
  assert.equal(rules(verdict), 'R3');
  assert.equal(verdict.label, 'ark');
});

test('R3: shell 命令直接拒绝，文件写入仍弹审批', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
  const shell = evaluate(policy, call('pwsh', { command: `echo ${secret}` }), env);
  assert.equal(shell.mode, 'deny');
  assert.match(shell.reason, /api-keys\.json/);

  const write = evaluate(policy, call('write', {
    file_path: 'D:\\work\\secrets.json',
    content: `{"key":"${secret}"}`,
  }), env);
  assert.equal(write.mode, 'ask');
});

test('R3: 普通文本不误伤', () => {
  assert.equal(evaluate(policy, call('write', {
    file_path: 'D:\\work\\a.md',
    content: 'token 消耗统计，token=数量不对；password 字段是可选的。',
  }), env), null);
});

test('模式可切换：deny 与 off', () => {
  const deny = { enabled: true, rules: { protectDshHome: { mode: 'deny', roots: ['~/.dsh'] } } };
  assert.equal(evaluate(deny, call('write', { file_path: 'C:\\Users\\Tester\\.dsh\\x' }), env).mode, 'deny');

  const off = { enabled: false };
  assert.equal(evaluate(off, call('write', { file_path: 'C:\\Users\\Tester\\.dsh\\x' }), env), null);

  const secretsOff = { enabled: true, rules: { secrets: { mode: 'off' } } };
  assert.equal(evaluate(secretsOff, call('pwsh', { command: 'echo sk-abcdefghijklmnopqrstuvwxyz' }), env), null);
});

test('critical: disk and boot operations are denied, not asked', () => {
  for (const command of [
    'format D:',
    'format.com D: /q',
    'diskpart /s usb.txt',
    'diskpart.exe /s usb.txt',
    'bcdedit /set {default} safeboot minimal',
    'bcdedit.exe /set {default} safeboot minimal',
    'vssadmin delete shadows /all',
    'reagentc /disable',
  ]) {
    const verdict = evaluate(policy, call('pwsh', { command }), env);
    assert.equal(verdict?.rule, 'R2', command);
    assert.equal(verdict.severity, 'critical', command);
    assert.equal(verdict.mode, 'deny', command);
    assert.match(verdict.reason, /critical/, command);
  }
});

test('critical: system files, permission changes and hives are denied', () => {
  for (const command of [
    'Remove-Item "C:\\Windows\\System32\\drivers\\etc\\hosts" -Force',
    'Set-Content C:\\Windows\\win.ini -Value x',
    'takeown /f "C:\\Windows\\System32" /r',
    'icacls "C:\\Program Files\\App" /grant Everyone:F',
    'reg delete HKLM\\SYSTEM\\CurrentControlSet\\Services\\Foo /f',
  ]) {
    const verdict = evaluate(policy, call('pwsh', { command }), env);
    assert.equal(verdict?.severity, 'critical', command);
    assert.equal(verdict.mode, 'deny', command);
  }
});

test('critical: an ordinary workspace delete stays an ask', () => {
  const verdict = evaluate(policy, call('pwsh', { command: 'Remove-Item -Recurse C:\\work\\dist' }), env);
  assert.equal(verdict.rule, 'R2');
  assert.equal(verdict.severity, undefined);
  assert.equal(verdict.mode, 'ask');
});

test('critical: read-only diagnostics are allowed', () => {
  for (const command of ['diskpart list disk', 'bcdedit /enum', 'vssadmin list shadows', 'reagentc /info', 'Get-Disk | Format-Table']) {
    assert.equal(evaluate(policy, call('pwsh', { command }), env), null, command);
  }
  // A write chained onto a read-only command must still be asked.
  const chained = evaluate(policy, call('pwsh', { command: 'bcdedit /enum & del D:\\work\\x' }), env);
  assert.equal(chained?.rule, 'R2');
  assert.equal(chained.mode, 'ask');
});

test('critical: policy can downgrade to ask or switch it off', () => {
  const ask = { enabled: true, rules: { critical: { mode: 'ask' } } };
  const downgraded = evaluate(ask, call('pwsh', { command: 'format D:' }), env);
  assert.equal(downgraded.mode, 'ask');
  assert.equal(downgraded.severity, 'critical');

  const off = { enabled: true, rules: { critical: { mode: 'off' } } };
  const plain = evaluate(off, call('pwsh', { command: 'format D:' }), env);
  assert.equal(plain.mode, 'ask');
  assert.equal(plain.severity, undefined);
});

test('critical: custom patterns join the critical tier', () => {
  const custom = { enabled: true, rules: { critical: { mode: 'deny', patterns: ['\\bwipe\\s+disk\\b'] } } };
  const verdict = evaluate(custom, call('pwsh', { command: 'wipe disk 0' }), env);
  assert.equal(verdict.severity, 'critical');
  assert.equal(verdict.category, 'custom');
});

test('critical: launcher and absolute-path spellings stay denied', () => {
  for (const command of [
    'cmd /c "diskpart /s usb.txt"',
    'cmd /c "reg delete HKLM\\SYSTEM\\Foo /f"',
    'C:\\Windows\\System32\\format.com D: /q /y',
    'regedit /s evil.reg',
  ]) {
    const verdict = evaluate(policy, call('pwsh', { command }), env);
    assert.equal(verdict?.severity, 'critical', command);
    assert.equal(verdict.mode, 'deny', command);
  }
  // Text that only mentions a tool is not a critical command.
  assert.equal(evaluate(policy, call('pwsh', { command: 'Write-Host "format D:"' }), env), null);
});

test('critical: evaluation failure fails closed for critical commands', () => {
  const broken = { rules: { critical: {} } }; // defaults: mode deny, failClosed true
  const denied = criticalFallback(broken, call('pwsh', { command: 'format D:' }), env);
  assert.equal(denied?.mode, 'deny');
  assert.equal(denied.severity, 'critical');

  assert.equal(criticalFallback({ rules: { critical: { failClosed: false } } }, call('pwsh', { command: 'format D:' }), env), null);
  assert.equal(criticalFallback({ rules: { critical: { mode: 'off' } } }, call('pwsh', { command: 'format D:' }), env), null);
  // Non-critical commands and non-shell tools keep the fail-open path.
  assert.equal(criticalFallback(broken, call('pwsh', { command: 'Get-Date' }), env), null);
  assert.equal(criticalFallback(broken, call('write', { file_path: 'D:\\work\\x' }), env), null);
});

test('R2: registry, service, scheduled task and firewall writes are asked', () => {
  for (const command of [
    'reg add HKLM\\Software\\Foo /v Bar /d 1 /f',
    'sc config Spooler start= disabled',
    'schtasks /create /tn Foo /tr bar.exe /sc daily',
    'netsh advfirewall set allprofiles state off',
    'Set-MpPreference -DisableRealtimeMonitoring $true',
    'Set-ItemProperty -Path HKLM:\\Software\\Foo -Name Bar -Value 1',
    'New-Service -Name Foo -BinaryPathName C:\\x.exe',
    'chkdsk D: /f',
    'dism /online /cleanup-image /restorehealth',
    'sfc /scannow',
    'reg.exe add HKLM\\Software\\Foo /v Bar /d 1 /f',
    'sc.exe config Spooler start= disabled',
    'schtasks.exe /create /tn Foo /tr bar.exe /sc daily',
  ]) {
    const verdict = evaluate(policy, call('pwsh', { command }), env);
    assert.equal(verdict?.rule, 'R2', command);
    assert.equal(verdict.mode, 'ask', command);
  }
});

test('自定义模式可追加', () => {
  const custom = {
    enabled: true,
    rules: { destructive: { mode: 'ask', patterns: ['\\bdrop\\s+table\\b'] } },
  };
  assert.equal(evaluate(custom, call('pwsh', { command: 'psql -c "drop table users"' }), env).rule, 'R2');
});

test('precedence: R3 runs before R1 and the critical tier', () => {
  // One command touches all three: a secret, the DSH home and a system hive.
  const command = 'Set-Content "$env:USERPROFILE\\.dsh\\AGENTS.md" -Value "sk-abcdefghijklmnopqrstuvwxyz"; reg delete HKLM\\SYSTEM\\Foo /f';
  const verdict = evaluate(policy, call('pwsh', { command }), env);
  assert.equal(verdict?.rule, 'R3');
  assert.equal(verdict.mode, 'deny');
});

test('precedence: R1 runs before the critical tier', () => {
  const command = 'Set-Content "$env:USERPROFILE\\.dsh\\AGENTS.md" -Value "x"; reg delete HKLM\\SYSTEM\\Foo /f';
  const verdict = evaluate(policy, call('pwsh', { command }), env);
  assert.equal(verdict?.rule, 'R1');
  assert.equal(verdict.mode, 'ask');
});

test('precedence: the critical tier runs before plain destructive patterns', () => {
  // "reg delete" also matches the ordinary R2 list; the critical verdict must win.
  const verdict = evaluate(policy, call('pwsh', { command: 'reg delete HKLM\\SYSTEM\\Foo /f' }), env);
  assert.equal(verdict?.rule, 'R2');
  assert.equal(verdict.severity, 'critical');
  assert.equal(verdict.mode, 'deny');
});

test('内置密钥正则本身不会自我命中', () => {
  // 把默认模式当成普通文本写进文件，不应触发 R3
  const text = DEFAULT_SECRETS.join('\n');
  assert.equal(evaluate(policy, call('write', { file_path: 'D:\\work\\policy.json', content: text }), env), null);
});
