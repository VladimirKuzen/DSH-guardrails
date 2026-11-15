# Changelog

Notable changes to the guardrail, newest first. Versions follow `dsh-guardrails/package.json`.

## [Unreleased]

- One README for the repository: the plugin-level README was removed, and the root README now covers
  installation, rules, and layout. Package `files` no longer lists it.
- Design notes moved from `docs/` to `design/`, so the root folder no longer collides with the plugin's
  `dsh-guardrails/docs/` (the source of the plugin detail page).
- MIT license added.
- Bilingual file headers; inline comments are English only.

## [1.2.2] - 2026-11-15

- Card warnings when the target is only partly visible: `reg import` / `load` / `restore` name the script
  file but not its contents; wildcard registry paths warn that the scope is unknown.

## [1.2.1] - 2026-11-15

- Registry cards show the registry key as the target instead of a flag such as `\v`.
- Reversibility is decided per verb: `reg add` reports "recovery method not assessed", while
  `reg delete` / `reg import` stay irreversible.

## [1.2.0] - 2026-11-15

- New critical tier (severity `critical`), refused without a card: formatting or partitioning a disk,
  `diskpart /s`, boot configuration writers, deleting `HKLM\SYSTEM` or `HKLM\SAM`, writes/deletes/moves
  under `%SystemRoot%` or `%ProgramFiles%`, and `takeown` / `icacls` aimed at those roots.
- Commands are unwrapped before matching: `cmd /c`, `powershell -Command`, `Start-Process`, and absolute
  tool paths. `regedit /s` is treated as critical because its script cannot be inspected.
- `rules.critical.failClosed` (default `true`): when evaluation throws on a call that looks critical, the
  call is refused without a card instead of being let through.
- R2 extended to registry writes, service creation/configuration, scheduled tasks, firewall and
  protection settings, `chkdsk /f`, `dism /remove-*`, and `sfc /scannow`.

## [1.1.0] - 2026-11-14

- Approval cards are built from collected facts plus localized text (zh / en), instead of one inline
  string per rule.
- Audit entries record the severity of critical hits; the heartbeat version is read from `package.json`.
