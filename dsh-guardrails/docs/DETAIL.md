# Guardrails for DSH

A small, dependency-free gate that sits on DSH's `tools/pre-execute` waterfall and decides **before**
a tool call runs. Hits are either refused or turned into a one-time approval prompt; every hit is also
written to a local audit file.

Windows only.

## What it watches

| Rule | Fires when | Default |
|---|---|---|
| **R1** DSH's own home | A write targets `~/.dsh` or `~/.agents`, a shell command both mentions those directories and carries a write/delete/move verb, or `plugin_manager` is used at all | ask |
| **R2** Destructive commands | Delete/move/rename in command position, `robocopy /MIR`, `git reset --hard`, `git clean -f`, `format`, `diskpart`, `reg add/delete/import`, `sc create/config/delete`, `schtasks`, `netsh advfirewall`, `Set-MpPreference`, `takeown`, `icacls`, `chkdsk /f`, `dism /remove-*`, `sfc /scannow` | ask |
| **R2 critical** | Formatting/partitioning a disk, `diskpart /s`, boot configuration writers, deleting `HKLM\SYSTEM` or `HKLM\SAM`, writes/deletes/moves inside `%SystemRoot%` or `%ProgramFiles%`, `takeown`/`icacls` aimed at those directories | deny |
| **R3** Secrets in arguments | Ark / `sk-` / `AKIA` / `ghp_` / `AIza` / `xox` / bearer tokens / private key blocks / `key=...` assignments | deny in shell commands, ask on file writes, label only |

Each rule can be switched to `deny` (refuse outright) or `off`. The critical tier also accepts
`rules.critical.mode: "ask"` (downgrade to an approval card with a ⛔ prefix) or `"off"` (plain R2).
`rules.critical.failClosed` (default `true`) keeps that tier refused when rule evaluation itself throws.

## Configuration

Policy lives outside the plugin at `~/.dsh/guardrails/policy.json` and is re-read within two seconds,
so changes do not need a restart:

```json
{
  "version": 1,
  "enabled": true,
  "rules": {
    "protectDshHome": { "mode": "ask", "roots": ["~/.dsh", "~/.agents"] },
    "destructive":    { "mode": "ask", "patterns": [] },
    "secrets":        { "mode": "ask", "patterns": [] }
  }
}
```

`patterns` appends your own regular expressions to the built-in lists.

## What you get afterwards

- **Audit**: `~/.dsh/guardrails/audit/audit-YYYY-MM-DD.jsonl`, one line per gated call.
- **Heartbeat**: `~/.dsh/guardrails/loaded.json`. Fresh mtime plus a matching version is the liveness
  signal; a pid proves nothing.
- **No new daemon**: it runs inside the DSH host process.

## Limits

- Tool calls only. Text typed into a conversation does not pass through it.
- Not a sandbox. A user with local access can still edit files directly.
- Pattern-based. Obfuscated shell can evade the destructive-command rules.

## After installing

Enable the bundle, then check `~/.dsh/guardrails/loaded.json` for a fresh timestamp. If the file is
stale, the plugin did not mount — do not assume the gate is active.
