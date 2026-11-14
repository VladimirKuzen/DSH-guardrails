# @vlad/dsh-guardrails

A DSH host plugin that gates risky tool calls before execution: **R1** protects DSH's own home,
**R2** catches destructive shell commands (with a **critical** tier that refuses disk, boot,
system-file and registry-hive operations outright), **R3** flags secrets in tool arguments.
Windows only.

Full documentation: [../README.md](../README.md) (English) ·
[../README.zh-CN.md](../README.zh-CN.md) (中文).

## What it does

Listens on the `tools/pre-execute` waterfall. Each call is evaluated once; a match returns `ask`
(one-time approval) or `deny`, writes one audit line, and refreshes the heartbeat. Anything that throws
is allowed through — the gate never bricks the tool chain.

| Rule | Default | Notes |
|---|---|---|
| R1 | ask | writes under `~/.dsh` / `~/.agents`, or any `plugin_manager` call |
| R2 | ask | deletes, moves, `robocopy /MIR`, `git reset --hard`, `format`, `reg add/delete`, `sc`, `schtasks`, `icacls`… |
| R2 critical | deny | disk formatting/partitioning, `diskpart /s`, boot configuration, `HKLM\SYSTEM`/`SAM` deletion, writes inside `%SystemRoot%`/`%ProgramFiles%` |
| R3 | deny in shell commands, ask on file writes | secret patterns; audit stores the label only, never the value |

## Configure

- Policy: `~/.dsh/guardrails/policy.json` (hot reloaded within 2 s)
- Modes per rule: `ask` / `deny` / `off`; `patterns` appends custom regular expressions
  (`rules.critical.mode` also accepts `ask` to downgrade the hard stop to a ⛔ card)
- Audit: `~/.dsh/guardrails/audit/audit-YYYY-MM-DD.jsonl`
- Heartbeat: `~/.dsh/guardrails/loaded.json` — check mtime and version, not pid

## Install

Link this package into a DSH profile and add it to `dsh.profile.bundles`, then restart DSH.
Host plugins do not hot-reload. See the repository README for the exact four steps.

## Test

```powershell
npm test   # rules, facts, describe, replay, critical, smoke
```

Use `node <file>`, not `node --test`: the DSH sandbox forbids the child processes that runner spawns.

## License

MIT.
