# Changelog

**English** | [中文](CHANGELOG.zh-CN.md)

Notable changes to the guardrail, newest first. Versions follow `dsh-guardrails/package.json`.

## [1.3.0] - 2026-11-15

- Audit rewrites itself as an event stream (`audit/v2/`): `requested` at the gate, `delivered` when the
  approval service accepts the question, `outcome` when the user or the guard decides, `executed` when an
  approved call really ran. The old single-file log stays readable; `audit.format: "v1"` falls back to it.
- The whole command text is stored under `payload/`, so "what exactly ran" is answerable later; secrets
  keep only the SHA-256. Targets are truncated by code point, not by byte.
- Records form a hash chain (`chain.json` + `prevHash`); `tools/audit-report.mjs --verify` detects an
  edited or truncated line, and `--stats` / `--show-payload` read the stream offline.
- One README for the repository: the plugin-level README was removed, and the root README now covers
  installation, rules, and layout. Package `files` no longer lists it.
- Design notes moved from `docs/` to `design/`, so the root folder no longer collides with the plugin's
  `dsh-guardrails/docs/` (the source of the plugin detail page).
- MIT license added; bilingual file headers, inline comments are English only.

## [1.2.3] - 2026-11-15

- Rules split into modules under `dsh-guardrails/lib/rules/` (`kit.js`, `r1-home.js`, `r2-destructive.js`,
  `r3-secrets.js`); `rules.js` keeps only the ordered dispatcher and the critical fallback. No behavior change.
- Precedence tests lock the order: R3 → R1 → R2 critical → R2 destructive.

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
