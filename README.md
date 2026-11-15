# dsh-guardrails

**English** | [中文](README.zh-CN.md)

A small, dependency-free guardrail for **DSH** that gates risky tool calls *before* they run,
and leaves a local audit trail of what was gated.

- **Host-native**: a DSH plugin listening on `tools/pre-execute`. No daemon, no proxy, no extra process.
- **Deterministic**: path and pattern rules only. No model calls, no network, no judgment from the same
  model that proposes the action.
- **Auditable**: every gated call writes one JSONL line; secrets are never written in clear text.
- **Windows-only**, pre-1.0. Path semantics assume Windows (`~`, `%VAR%`, `$env:VAR`, backslashes).

**Status**: v1.4.0. The critical tier and the audit v2 stream were verified live on Windows 11
(2026-11-15): denied calls return no card and never execute, an approved call produces the full
`requested → delivered → outcome → executed` chain with a payload, and `--verify` validates the hash chain.
See [design/p1.6-windows-critical.md](design/p1.6-windows-critical.md) §11 and
[design/p2-audit-v2.md](design/p2-audit-v2.md) §0 for the probe logs.

## Why

An agent is most dangerous at the boundary between a sentence and an action: it can rewrite its own
configuration, delete a directory it misread, or paste an API key into a log. Prompt-level instructions
do not stop any of that. This gate sits on the last hop before execution and asks a human — or refuses.

## Rules

| Rule | Fires when | Default |
|---|---|---|
| **R1** Protect DSH's own home | Tool writes inside `~/.dsh` or `~/.agents`; a shell command both mentions those directories and carries a write/delete/move verb; any `plugin_manager` operation | ask |
| **R2** Destructive operations | Delete/move/rename in command position, `robocopy /MIR`, `git reset --hard`, `git clean -f`, `format`, `diskpart`, `reg add/delete/import`, `sc create/config/delete`, `schtasks`, `netsh advfirewall`, `Set-MpPreference`, `takeown`, `icacls`, `chkdsk /f`, `dism /remove-*`, `sfc /scannow` | ask |
| **R2 critical** (severity) | Formatting/partitioning a disk, `diskpart /s`, boot configuration writers (`bcdedit`, `bootrec`, `vssadmin delete`, `wbadmin delete`, `reagentc`), deleting `HKLM\SYSTEM` or `HKLM\SAM`, writing/deleting/moving anything inside `%SystemRoot%` or `%ProgramFiles%`, `takeown`/`icacls` aimed at those directories | deny |
| **R3** Secrets in tool arguments | Ark / `sk-` / `AKIA` / `ghp_` / `AIza` / `xox` / bearer tokens / private key blocks / `key=...` assignments | deny in shell commands, ask on file writes (label only) |

Every rule can be set to `ask`, `deny` or `off`.

Critical operations are refused instead of asked: one "allow once" click can leave Windows unbootable,
the target (disk number, partition layout, hive contents) cannot be verified from the command text, and
the mistake is only visible after a reboot. The refusal returns an English reason to the model; run the
command yourself in a terminal if you really mean it. Read-only diagnostics (`Get-Disk`,
`diskpart list disk`, `bcdedit /enum`, `vssadmin list shadows`, `reagentc /info`, `dism /scanhealth`)
stay allowed, and an ordinary workspace delete is still a normal ask. Set `rules.critical.mode` to
`ask` to downgrade it to an approval card (⛔ prefix) or `off` to fall back to plain R2.

Read-only calls and ordinary writes inside the workspace are not touched.

R3 is deliberately stricter. The host renders the approval card from the tool call and echoes a shell
command verbatim, so asking about one would put the secret on screen. A secret inside a shell command
is therefore refused outright; a file write, whose content is never echoed, still asks.

## How a call is judged

```
tool call ──▶ evaluate(policy, call, env) ──▶ null ──────────────▶ allow
                                              └─▶ { rule, mode } ──▶ audit + heartbeat
                                                                     ├─ ask  → approval prompt (once)
                                                                     └─ deny → refused, reason returned
```

The plugin is **fail-open**: if policy parsing or rule evaluation throws, the call proceeds. A guardrail
must not brick the tool chain. The one exception is the critical tier: when evaluation breaks, a shell
command that still matches the critical matcher is refused instead of run (`rules.critical.failClosed`,
on by default). If the plugin itself never mounts, the host simply runs unguarded — `loaded.json` exists
so that this state is detectable (see below).

## Install

Requires DSH on Windows. The package is not on a registry yet; link the checkout into a profile:

1. Add the dependency to `%USERPROFILE%\.dsh\profiles\<profile>\package.json`:

   ```json
   "@vlad/dsh-guardrails": "link:<absolute path to this repo>\\dsh-guardrails"
   ```

2. Add `@vlad/dsh-guardrails` to `dsh.profile.bundles` in the same file.
3. Run `pnpm install` in the profile directory.
4. Restart DSH. Host plugins do not hot-reload.

Verify it mounted: `~/.dsh/guardrails/loaded.json` should have a fresh mtime and a version matching
`dsh-guardrails/package.json`. **Do not trust the pid** — the host process can be replaced while the gate
keeps working in a new one. Freshness plus version is the signal.

## Configure

| What | Where |
|---|---|
| Policy | `~/.dsh/guardrails/policy.json` — re-read within 2 seconds, no restart |
| Policy override | Environment variable `DSH_GUARDRAILS_POLICY` |
| Audit | `~/.dsh/guardrails/audit/v2/` — one JSONL per day, payloads, and a hash chain |
| Heartbeat | `~/.dsh/guardrails/loaded.json` |

```json
{
  "version": 1,
  "enabled": true,
  "audit": { "format": "v2", "maxPayloadBytes": 65536 },
  "rules": {
    "protectDshHome": { "mode": "ask", "roots": ["~/.dsh", "~/.agents"] },
    "critical":       { "mode": "deny", "patterns": [], "failClosed": true },
    "destructive": {
      "mode": "ask",
      "patterns": [],
      "workspaceQuiet": {
        "enabled": false,
        "roots": ["D:\\work\\guardrails"],
        "paths": ["_scratch/", "build/", "dist/"],
        "alwaysAsk": [".git", ".", ".."]
      }
    },
    "secrets":        { "mode": "ask", "patterns": [] }
  }
}
```

`patterns` appends your own regular expressions to the built-in lists. `critical.patterns` adds your own
regexes to the hard-stop tier; `critical.failClosed` keeps that tier closed when evaluation itself throws.
A corrupt policy file is ignored in favour of the last good copy — the gate never disappears because of a
bad edit. `audit.format: "v1"` falls back to the old single-file log.

`destructive.workspaceQuiet` (off by default) turns the routine cleanup of one temp file into a silent
allow: the shell call has exactly one statement and one target, no `-Recurse`, no wildcard, and an
absolute path under one of `roots` and under one of `paths`. `-Force` is allowed when those hold. Anything
else still asks; R1, R3 and the critical tier are untouched. If a session cwd is known and lies outside
`roots`, quiet disables itself and writes one `config-invalid` record; when no cwd is known that
cross-check is skipped and the configured absolute roots decide on their own.

## Audit

Every gated call becomes a short chain of records sharing one `id`: `requested` at the gate, `delivered`
when the approval service accepts the question, `outcome` when the user or the guard decides, and
`executed` when an approved call really ran. P1.7 silent allows write `allowed` instead. Records are
linked by `prevHash`, so an edited or truncated line is detectable; the full command text is stored under
`payload/` (secrets keep only their hash). `cwd` and `cwdSource` (`session` / `tool` / `null`) record the
working directory the decision was made in; misconfiguration writes `config-invalid`.

Read it offline:

```powershell
node dsh-guardrails/tools/audit-report.mjs            # last 20 events
node dsh-guardrails/tools/audit-report.mjs --stats     # counts by event / rule / outcome
node dsh-guardrails/tools/audit-report.mjs --verify    # hash-chain check, exit 1 when broken
node dsh-guardrails/tools/audit-report.mjs --rule R2 --event outcome --show-payload
```


## Repository layout

| Path | Purpose |
|---|---|
| `dsh-guardrails/` | The plugin: `index.js` (host wiring), `rules.js` (pure decision logic) |
| `dsh-guardrails/test/` | Rule tests and package smoke test |
| `dsh-guardrails/tools/` | `audit-report.mjs` — offline reader for the audit stream |
| `design/` | Design notes and boundary records — the P1.6 critical tier and its known limits |
| `CHANGELOG.md` | Release history — English and Chinese versions |
| `scripts/` | Maintainer tooling — audit redaction, snapshot/restore, health check. **Kept local (git-ignored), not part of this repository** |

Maintainer tooling exists because audit files contain command text and paths. It snapshots and redacts
them locally, then encrypts the result with Windows DPAPI (bound to the current user account).

## Development

No build step, no runtime dependencies. Tests run directly:

```powershell
npm test   # runs the eight test files in order
```

Run them with `node <file>`, not `node --test`: the DSH sandbox forbids the child processes that runner spawns.

## Limits

- **Not a sandbox.** It sees tool calls only. Text pasted straight into a conversation bypasses it, and a
  user with local access can edit files directly.
- **Rules are regex- and path-based.** `cmd /c`, `powershell -Command`, `Start-Process` and absolute tool
  paths are unwrapped before matching, but variable assembly (`$tool = 'for' + 'mat'`) and encoded commands
  (`powershell -EncodedCommand`) can still evade the destructive-command patterns; R1's path check is the
  stronger of the three.
- **Indirect execution stays invisible.** `powershell -File x.ps1`, `reg import`, and a `.reg` file opened
  outside DSH never pass through the matcher (`regedit /s` is refused as a critical operation because its
  script is invisible). The critical tier covers command text, not the contents of scripts or hives.
- **Approval surfaces may not match the plan.** The host renders the decision prompt; the plugin can only
  supply its text.
- **Audit covers gated calls only.** Calls that never hit a rule are not logged, and a call the gate never
  saw leaves no trace. Records prove what the plugin decided and what the host executed, not what happened
  outside DSH.
- Windows only.

## Uninstall

Remove `@vlad/dsh-guardrails` from the profile's `dsh.profile.bundles` and its `dependencies`, then
restart DSH. Existing audit files are left in place; delete them yourself if you want them gone.

## License

MIT.
