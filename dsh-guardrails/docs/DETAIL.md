# Guardrails for DSH

A small, dependency-free gate that sits on DSH's `tools/pre-execute` waterfall and decides **before**
a tool call runs. Hits are either refused or turned into a one-time approval prompt; every hit is also
written to a local audit file.

Windows only.

## What it watches

| Rule | Fires when | Default |
|---|---|---|
| **R1** DSH's own home | A write targets `~/.dsh` or `~/.agents`, a shell command both mentions those directories and carries a write/delete/move verb, or `plugin_manager` is used at all | ask |
| **R1 self** The gate's own source | A write, or a shell command carrying a write verb, targets this plugin's directory (and any extra root in `rules.selfProtect.paths`) | ask |
| **R2** Destructive commands | Delete/move/rename in command position, `robocopy /MIR`, `git reset --hard`, `git clean -f`, `format`, `diskpart`, `reg add/delete/import`, `sc create/config/delete`, `schtasks`, `netsh advfirewall`, `Set-MpPreference`, `takeown`, `icacls`, `chkdsk /f`, `dism /remove-*`, `sfc /scannow` | ask |
| **R2 critical** | Formatting/partitioning a disk, `diskpart /s`, boot configuration writers, deleting `HKLM\SYSTEM` or `HKLM\SAM`, writes/deletes/moves inside `%SystemRoot%` or `%ProgramFiles%`, `takeown`/`icacls` aimed at those directories | deny |
| **R3** Secrets in arguments | Ark / `sk-` / `AKIA` / `ghp_` / `AIza` / `xox` / bearer tokens / private key blocks / `key=...` assignments | deny in shell commands, ask on file writes, label only |

Each rule can be switched to `deny` (refuse outright) or `off`. The critical tier also accepts
`rules.critical.mode: "ask"` (downgrade to an approval card with a ⛔ prefix) or `"off"` (plain R2).
`rules.critical.failClosed` (default `true`) keeps that tier refused when rule evaluation itself throws.

A protected path only counts when it is the **operand of a write verb**. The check reads the command as
statements, finds each write verb (`Set-Content`, `Remove-Item`, `WriteAllText`, `>`, …) inside its
statement, and resolves that verb's own arguments — a literal path, or a variable assigned one earlier
in the same command (`$p = Join-Path $env:USERPROFILE '.dsh\guardrails\policy.json'; Set-Content $p`).
A path that merely appears somewhere in the command is not a target: running the bundled node
(`& "…\.dsh\…\node.exe" script.mjs`), or reading a file with `Get-Content`, does not make the nearby
`Set-Content` write to it, so the card never names a program as the thing about to be overwritten.

`observe` and `allow` are the P3 additions, and they only exist under `"version": 2`. Under `version: 1`
the file behaves exactly as it always has: `allow` is treated as `ask` and `observe` is rejected at load
time (`observe-requires-v2`), so a policy cannot change meaning by accident.

Self-protection (`rules.selfProtect`) accepts only `ask`, `deny` and — under `"version": 2` — `observe`:
`off` and `allow` are rejected, because a switch that the file it protects could turn off is not a gate. The
`observe` setting is a development truce: edits to the gate are recorded (`observed`) instead of carded, so a
change can be made and reviewed afterwards, but it is not a mode to ship with. It covers the plugin directory
the host actually loaded, so editing `rules.js` or `lib/` through a tool raises a card. It is **not a sandbox**:
hand edits, other processes, an `fs` write inside the plugin itself, and `apply_patch` calls whose arguments
carry only patch text all bypass it.

## Dry run before an unreadable delete (P1.8)

A card is a short line: `⚠ Delete · irreversible`. When the command's target is a variable
(`Remove-Item "$dir\$name" -Recurse`), or the command is very long, or it chains several destructive
steps, that line is all the approval prompt can say — and it is not enough to consent to.

With `rules.destructive.dryRun.enabled` (default `false`), the first attempt is refused instead of carded,
with an instruction to enumerate the exact paths first with a read-only command. The second attempt — same
session, same command shape — gets the ordinary card, plus `dry run was requested first`.

```json
"destructive": {
  "mode": "ask",
  "dryRun": { "enabled": true, "minChars": 400, "minStatements": 3, "dynamicTarget": true }
}
```

The gate cannot verify that the listing was actually produced; it only makes the first attempt fail in a
way that asks for one. The prompt closes as soon as the same command is retried, so this is a nudge, not a
check. Commands already describable on the card (a literal, single target) are never delayed.

## What a card names

The card answers three questions about the call, not about the tool: what happens (`delete`, `move`,
`overwrite`, a registry write), to what (the target path, clipped to 72 characters), and whether it can be
undone.

Two rules keep that honest when the command is not a single tidy action:

- **The worst action, not the first.** `New-Item … ; Remove-Item …` reads as a delete. Naming the harmless
  setup step would hide the irreversible one.
- **A target set by a variable is named as such.** When the path comes from a variable the card says
  `target set by a variable` and, after a dry run, `see the read-only listing above` — it never silently
  drops the segment, which used to read as "no target at all".

The card still cannot show the command itself: the host renders the tool call separately and truncates long
arguments, and approval requests carry no body of our own. Compressing the command into facts is therefore
the only lever, which is what the dry run above exists for.

## Configuration

Policy lives outside the plugin at `~/.dsh/guardrails/policy.json` and is re-read within two seconds,
so changes do not need a restart. The file is checked against `policy.schema.json` (unknown keys are
rejected, so a typo cannot silently disable a rule); a file that fails validation is ignored and the
previous good policy stays live, with one `config-invalid` audit record and a warning in the host log:

```json
{
  "version": 2,
  "enabled": true,
  "rules": {
    "protectDshHome": { "mode": "ask", "roots": ["~/.dsh", "~/.agents"] },
    "destructive":    { "mode": "ask", "patterns": [] },
    "secrets":        { "mode": "ask", "patterns": [] },
    "selfProtect":    { "mode": "ask", "paths": [] }
  },
  "entries": [
    {
      "id": "no-dist-delete",
      "tool": ["pwsh"],
      "mode": "deny",
      "when": { "commandMatches": "^\\s*Remove-Item\\b.*\\\\dist\\b" }
    }
  ]
}
```

`patterns` appends your own regular expressions to the built-in lists.

## Custom entries (P3, `version: 2`)

An entry says "this tool, under these conditions, gets this outcome". All three `when` conditions must hold
(`cwdUnder`, `targetUnder`, `commandMatches`); an entry without `when` applies to every call of the listed
tools. `targetUnder` is a path check, so it never matches a shell command's inline text — use `commandMatches`
for those, and anchor it with `^` (unanchored patterns are rejected at load time).

The four outcomes rank `deny` > `ask` > `observe` > `allow`. Entries compete with the built-in rules in one
ranking, so an `entries.deny` can tighten a block that was lowered to `ask`, and an `entries.allow` never
clears a built-in hit — it only records "this was declared allowed" (rank 0). The card says the rule in
words (`Custom rule no-dist-delete blocks this call`), while the audit record keeps `rule: "E"` and
`entryId`, plus every hit in `reasons[]`.

## Relaxing a rule

To stop asking about a class of commands, lower a whole block's `mode` and keep the dangerous subset caught:

- `"mode": "deny"` refuses the block outright; `"off"` disables it (no record at all).
- `"mode": "observe"` (`version: 2`) lets every hit through and writes an `observed` record — the rehearsal
  mode, for finding out how often a rule would fire before trusting it.
- `"mode": "allow"` (`version: 2`) lets the block through and writes an `allowed` record.
- Or enable `destructive.workspaceQuiet` (P1.7): in-workspace deletes stop asking, temp-directory and
  recursive deletes still do.
- Then add `entries` with `mode: "deny"` for the commands that must stay refused (rank 3 still wins inside
  the block that was relaxed).

Under `version: 1` only the first bullet exists: `allow` is treated as `ask` and `observe` is rejected at
load time, so the old files keep their old behaviour. `entries.allow` is never a way to whitelist a false
positive — it ranks below every built-in `ask`/`deny`/`observe`.

## Checking a call from the command line (P3)

`dsh-guardrails check` (or `node tools/check.mjs`) puts one tool call through the same engine the host uses
and answers with an exit code:

    node tools/check.mjs --tool pwsh --args '{"command":"git reset --hard"}'

Exit codes: `0` allowed (including `observe` and the workspace quiet), `2` would be shown for approval, `3`
refused, `1` usage or policy error — `1` never means "allowed", so a script cannot mistake a typo for a
permission. Add `--json` for `{decision, exitCode, winner, reasons, facts, cwd}`; `winner.mode` is what
tells an `observe` apart from a plain allow.

- `--args -` reads the arguments from stdin. On Windows this is the reliable form: PowerShell splits and
  re-quotes inline JSON, so `--args "{...}"` can arrive mangled.
- `--cwd <path>` decides relative paths. Only the CLI defaults to the current directory; the host never
  trusts `process.cwd()` for a tool call.
- The CLI writes no audit records and does not touch the heartbeat: it is a question, not a call.

An invalid policy file is an error here (exit 1) instead of a silent fallback: a one-shot question has no
last good policy to keep, and the host's "keep the previous policy" behaviour would hide the typo.

## What you get afterwards

- **Audit**: `~/.dsh/guardrails/audit/v2/` — `requested` / `delivered` / `outcome` / `executed` records,
  plus `allowed` for the opt-in workspace quiet (P1.7) and for `mode: "allow"` blocks, plus `observed` for
  `mode: "observe"` blocks (P3), with a hash chain; full command text lives under `payload/`, secrets keep only
  the hash. Read it with `node tools/audit-report.mjs --stats --verify`.
- **Heartbeat**: `~/.dsh/guardrails/loaded.json`. Fresh mtime plus a matching version is the liveness
  signal; a pid proves nothing.
- **No new daemon**: it runs inside the DSH host process.

## Limits

- Tool calls only. Text typed into a conversation does not pass through it.
- Not a sandbox. A user with local access can still edit files directly.
- Self-protection is an obstacle, not a boundary: it stops the agent from editing the gate through a tool,
  not a hand edit, another process, or a write issued from inside the plugin.
- Pattern-based. Obfuscated shell can evade the destructive-command rules.
- The dry run is a nudge: retrying the same command clears it, and the gate cannot tell whether a listing
  was actually produced.

## After installing

Enable the bundle, then check `~/.dsh/guardrails/loaded.json` for a fresh timestamp. If the file is
stale, the plugin did not mount — do not assume the gate is active.
