import test from 'node:test';
import assert from 'node:assert/strict';

import { criticalVerdict, readOnlyDiagnostic, systemRoots } from '../lib/critical.js';

const env = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  USERPROFILE: 'C:\\Users\\Tester',
};

const category = (command) => criticalVerdict(command, env)?.category ?? null;

test('critical: disk formatting and partition tools', () => {
  assert.equal(category('format D:'), 'disk');
  assert.equal(category('format.com C: /q'), 'disk');
  assert.equal(category('Format-Volume -DriveLetter D'), 'disk');
  assert.equal(category('Clear-Disk -Number 2 -RemoveData'), 'disk');
  assert.equal(category('Initialize-Disk -Number 1'), 'disk');
  assert.equal(category('Remove-Partition -DriveLetter D -Confirm:$false'), 'disk');
});

test('critical: diskpart scripts and destructive verbs', () => {
  assert.equal(category('diskpart /s usb.txt'), 'disk');
  assert.equal(category('diskpart\nselect disk 0\nclean'), 'disk');
  const verdict = criticalVerdict('diskpart clean', env);
  assert.equal(verdict.category, 'disk');
  assert.equal(verdict.detail, 'diskpart clean');
});

test('critical: read-only diskpart stays usable', () => {
  assert.equal(criticalVerdict('diskpart list disk', env), null);
  assert.equal(readOnlyDiagnostic('diskpart list disk'), true);
});

test('critical: boot configuration writers', () => {
  assert.equal(category('bcdedit /set {default} safeboot minimal'), 'boot');
  assert.equal(category('bootrec /fixmbr'), 'boot');
  assert.equal(category('vssadmin delete shadows /all /quiet'), 'boot');
  assert.equal(category('wbadmin delete backup -quiet'), 'boot');
  assert.equal(category('reagentc /disable'), 'boot');
});

test('critical: boot read-only diagnostics stay allowed', () => {
  assert.equal(criticalVerdict('bcdedit /enum', env), null);
  assert.equal(criticalVerdict('bootrec /scanos', env), null);
  assert.equal(criticalVerdict('vssadmin list shadows', env), null);
  assert.equal(criticalVerdict('reagentc /info', env), null);
  assert.equal(readOnlyDiagnostic('bcdedit /enum'), true);
  assert.equal(readOnlyDiagnostic('reagentc /info'), true);
});

test('critical: deleting a system registry hive', () => {
  const system = criticalVerdict('reg delete HKLM\\SYSTEM\\CurrentControlSet\\Services\\Foo /f', env);
  assert.equal(system.category, 'registry');
  assert.equal(system.detail, 'HKLM\\SYSTEM');

  const sam = criticalVerdict('reg delete "HKLM\\SAM" /f', env);
  assert.equal(sam.category, 'registry');

  assert.equal(criticalVerdict('reg delete HKCU\\Software\\Foo /f', env), null);
});

test('critical: deleting or overwriting files under a system directory', () => {
  assert.equal(category('Remove-Item "C:\\Windows\\System32\\drivers\\etc\\hosts" -Force'), 'systemfiles');
  assert.equal(category('del %SystemRoot%\\Temp\\x.log'), 'systemfiles');
  assert.equal(category('Set-Content C:\\Windows\\win.ini -Value x'), 'systemfiles');
  assert.equal(category('Remove-Item "C:\\Program Files\\App" -Recurse'), 'systemfiles');
  assert.equal(category('echo x > C:\\Windows\\System32\\x.dll'), 'systemfiles');
  // Moving a system file away also removes it from the system directory.
  assert.equal(category('move C:\\Windows\\foo.exe D:\\backup'), 'systemfiles');
  // A nested shell command is inspected too.
  assert.equal(category('cmd /c "del C:\\Windows\\System32\\x.dll"'), 'systemfiles');
});

test('critical: copying INTO a system directory counts, copying OUT does not', () => {
  assert.equal(category('Copy-Item .\\x.exe C:\\Windows\\y.exe'), 'systemfiles');
  assert.equal(category('Copy-Item C:\\Windows\\notepad.exe D:\\backup'), null);
});

test('critical: takeown and icacls only when aimed at a system directory', () => {
  assert.equal(category('takeown /f "C:\\Windows\\System32" /r'), 'permissions');
  assert.equal(category('icacls "C:\\Program Files\\App" /grant Everyone:F'), 'permissions');
  assert.equal(category('takeown /f D:\\work\\x'), null);
  assert.equal(category('icacls D:\\work\\x /grant Everyone:F'), null);
});

test('critical: ordinary workspace commands are untouched', () => {
  assert.equal(criticalVerdict('Remove-Item -Recurse C:\\work\\dist', env), null);
  assert.equal(criticalVerdict('git status', env), null);
  assert.equal(criticalVerdict('Get-ChildItem C:\\Windows', env), null);
});

test('critical: read-only pipeline is recognised as a whole', () => {
  assert.equal(readOnlyDiagnostic('Get-Disk | Format-Table'), true);
  assert.equal(readOnlyDiagnostic('Get-Disk; Remove-Item C:\\work\\dist'), false);
  assert.equal(readOnlyDiagnostic('diskpart clean'), false);
  assert.equal(readOnlyDiagnostic('diskpart /s usb.txt'), false);
  // A read-only command chained with a write is not read-only.
  assert.equal(readOnlyDiagnostic('bcdedit /enum & del D:\\work\\x'), false);
});

test('systemRoots: falls back to the classic Windows paths', () => {
  assert.deepEqual(systemRoots({}), ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)']);
  assert.ok(systemRoots(env).includes('c:\\windows'));
});

test('critical: ".exe" spellings are treated the same', () => {
  assert.equal(category('diskpart.exe /s usb.txt'), 'disk');
  assert.equal(category('bcdedit.exe /set {default} safeboot minimal'), 'boot');
  assert.equal(category('reg.exe delete HKLM\\SYSTEM\\Foo /f'), 'registry');
  assert.equal(category('takeown.exe /f C:\\Windows\\System32 /r'), 'permissions');
  assert.equal(readOnlyDiagnostic('bcdedit.exe /enum'), true);
});

test('critical: launchers and absolute paths cannot hide a critical command', () => {
  // cmd /c with the payload in quotes
  assert.equal(category('cmd /c "diskpart /s usb.txt"'), 'disk');
  assert.equal(category('cmd /c "reg delete HKLM\\SYSTEM\\Foo /f"'), 'registry');
  assert.equal(category('cmd /c format D: /q /y'), 'disk');
  // absolute path to the tool, quoted or not
  assert.equal(category('C:\\Windows\\System32\\format.com D: /q /y'), 'disk');
  assert.equal(category('& "C:\\Windows\\System32\\format.com" D: /q /y'), 'disk');
  assert.equal(category('C:\\Windows\\System32\\diskpart.exe /s usb.txt'), 'disk');
  // Start-Process, with and without -FilePath
  assert.equal(category("Start-Process format -ArgumentList 'D:', '/q', '/y'"), 'disk');
  assert.equal(category("Start-Process -FilePath diskpart -ArgumentList '/s usb.txt'"), 'disk');
  // regedit /s applies an invisible script
  assert.equal(category('regedit /s evil.reg'), 'registry');
});

test('critical: mentioning a tool in output is not a command', () => {
  assert.equal(criticalVerdict('Write-Host "format D:"', env), null);
  // A read-only diskpart wrapped in cmd /c stays readable.
  assert.equal(readOnlyDiagnostic('cmd /c "diskpart list disk"'), true);
});
