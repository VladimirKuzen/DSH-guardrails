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

Self-protection (`rules.selfProtect`) is the one rule whose mode accepts only `ask` or `deny`: a switch
that the file it protects could turn off is not a gate. It covers the plugin directory the host actually
loaded, so editing `rules.js` or `lib/` through a tool raises a card. It is **not a sandbox**: hand edits,
other processes, an `fs` write inside the plugin itself, and `apply_patch` calls whose arguments carry only
patch text all bypass it.

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
  "version": 1,
  "enabled": true,
  "rules": {
    "protectDshHome": { "mode": "ask", "roots": ["~/.dsh", "~/.agents"] },
    "destructive":    { "mode": "ask", "patterns": [] },
    "secrets":        { "mode": "ask", "patterns": [] },
    "selfProtect":    { "mode": "ask", "paths": [] }
  }
}
```

`patterns` appends your own regular expressions to the built-in lists.

## Relaxing a rule

To stop asking about a class of commands, policy has only two directions: lower a whole block's `mode` to
`deny`/`off`, or enable `destructive.workspaceQuiet` (in-workspace deletes go through). Writing
`"mode": "allow"` relaxes nothing today — R1 / R2 / R3 all treat it as `ask`
(`dsh-guardrails/lib/rules/r2-destructive.js:63`).

P3 adds an `entries` table (not implemented yet, see `design/p3-policy-v2.md` §2.2). Its `allow` entries rank
lowest and never outvote a built-in `ask`/`deny`/`observe`; they only record "this command was explicitly
declared allowed". They cannot clear a false positive. Relaxing for real means lowering a block's `mode` and
using `entries.deny` to keep the dangerous subset caught.

## What you get afterwards

- **Audit**: `~/.dsh/guardrails/audit/v2/` — `requested` / `delivered` / `outcome` / `executed` records,
  plus `allowed` for the opt-in workspace quiet (P1.7)
  with a hash chain; full command text lives under `payload/`, secrets keep only the hash. Read it with
  `node tools/audit-report.mjs --stats --verify`.
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
