# Writing a policy

The file the gate reads, what each key does, and how to change behaviour without
turning the gate off. `DETAIL.md` explains what the gate checks; this page is
about configuring it.

## Where the file lives

| Location | When it is read |
|---|---|
| `~/.dsh/guardrails/policy.json` | Always, once mounted |
| `$DSH_GUARDRAILS_POLICY` | Instead of the path above, when set |
| Plugin entry config (profile) | Merged under the file's values |

Precedence is defaults → file → plugin entry config, and the file is the only
one re-read at runtime.

## How a change takes effect

- Edits are picked up within about two seconds; no restart, no reload.
- A file that fails to parse **or** to validate is ignored and the previous good
  policy keeps applying. One `logger.warn` and one `config-invalid` record are
  written (the record says which field, e.g. `rules.quiet.enabled`).
- Saving with a BOM is fine; a BOM is stripped before parsing.
- Editing this file is itself a write into `~/.dsh`, so R1 asks for it. Removals
  with a shell tool are the same story — use the editor, then the file just
  reloads.

## The shape

```json
{
  "version": 2,
  "enabled": true,
  "auditDir": "~/.dsh/guardrails/audit",
  "audit": { "format": "v2", "maxPayloadBytes": 65536 },
  "rules": {
    "protectDshHome": { "mode": "ask", "roots": ["~/.dsh", "~/.agents"], "alwaysAskTools": ["plugin_manager"] },
    "critical": { "mode": "deny", "patterns": [], "failClosed": true },
    "destructive": { "mode": "ask", "patterns": [], "dryRun": { "enabled": false, "minChars": 400, "minStatements": 3, "dynamicTarget": true } },
    "secrets": { "mode": "ask", "patterns": [] },
    "selfProtect": { "mode": "ask", "paths": [] },
    "quiet": { "enabled": false, "roots": [], "paths": ["_scratch"], "alwaysAsk": [".git", ".", ".."] }
  },
  "entries": []
}
```

`version` selects the engine. `1` (or absent) is the original semantics; `2`
adds ranked resolution, `observe`, `allow` and `entries`. `enabled: false` turns
the whole gate off; prefer a narrower change.

## The five modes

| Mode | Engine | What happens |
|---|---|---|
| `deny` | v1 | Refused; the model gets the reason string, no card |
| `ask` | v1 | Card; on approval the call runs once |
| `off` | v1 | The rule does not match at all — no card, no record |
| `observe` | v2 | Recorded as `observed`, allowed, no card |
| `allow` | v2 | Recorded as `allowed`, allowed — and it can still lose to a stricter band |

`critical` accepts only `deny`, `ask` or `off`. The hard stop is not something a
policy can downgrade past "ask".

## Loosening a rule

There is no per-command exemption list. What exists, from most to least
surgical:

1. **Let workspace quiet decide.** `rules.quiet.enabled: true` with `roots` set
   to your workspace lets one routine delete inside it (single statement, one
   resolved file, not the quiet directory itself, not `.git`) proceed without a
   card, and records `allowed` with `quiet: "workspace"`. Everything else still
   asks.
2. **Raise the dry-run threshold** or turn it off — see below. This changes how
   often a card is deferred, not what is allowed.
3. **Lower one band's mode.** `observe` records instead of asking; `allow`
   allows outright (v2 only). Do this band by band, not `enabled: false`.
4. **Narrow what a band sees** — `protectDshHome.roots`, `selfProtect.paths`,
   `quiet.paths`.

If you lower a band to `observe` or `allow` and something in it was load
bearing, put a `deny` entry back over the dangerous subset. That is the
whitelist-inversion pattern in `examples/policy/relax-with-guard.json`.

### The three-step grayscale

1. **Annotate, keep asking.** Leave the band at `ask` and add an `entries`
   `observe` entry. Cards still appear; each one records `entryId`, so you learn
   how often and where.
2. **Record only.** Lower the band to `observe`, and add `entries` `deny` for the
   subset you do not want to see at all. Now nothing asks, everything is
   recorded.
3. **Relax for real** (or fix the pattern). If the bandwidth is genuinely
   correct, `allow`; if it is too broad, change the built-in pattern and add a
   test — see `CHANGELOG.md` for why patterns are code, not config.

Approval history is the other half of the evidence: `outcome` shows whether you
said yes when asked. A rule that fires often and is approved often is usually
too broad; one approved rarely is usually doing its job.

## Tightening

`entries` with `deny` is the usual way:

```json
{
  "id": "no-force-push",
  "tool": ["pwsh", "bash"],
  "mode": "deny",
  "when": { "commandMatches": "\\bgit\\s+push\\b[^|;]*--force" }
}
```

- `id` is what appears in the card, the audit and `check` output.
- `mode` is `deny`, `ask`, `observe` or `allow`.
- `when` needs at least one of `cwdUnder`, `targetUnder`, `commandMatches`; the
  three are ANDed. Path conditions take absolute paths (or `~` / `%VAR%`).
- `commandMatches` is a regular expression that must start with `^`; it is
  applied to shell commands only.
- `allow` entries require a narrowing condition, and they never beat a built-in
  `ask`/`deny` — they exist to be explicit and visible in the audit, not to
  grant exemptions.

## Dry run

`rules.destructive.dryRun` decides when an ordinary (non-critical) destructive
`ask` is refused on the first attempt instead of being shown:

| Key | Meaning |
|---|---|
| `enabled` | On or off for the whole gate |
| `dynamicTarget` | Refuse when the target cannot be named (a variable the card cannot resolve) |
| `minChars` | Refuse when the command text is longer than this (default 400) |
| `minStatements` | Refuse when the command has at least this many destructive statements (default 3) |

The refusal tells the model to run a read-only listing first; the retry of the
**same** command is carded and the card says the dry run was requested. This
nudges a readable card into existence; it cannot verify that the listing ran.

## Templates

Copy, then check:

| File | Use |
|---|---|
| `examples/policy/minimal-v1.json` | Smallest working file, original semantics |
| `examples/policy/observe-first.json` | Watch package installs before deciding |
| `examples/policy/tighten.json` | Ban force-push and `.git` writes outright |
| `examples/policy/relax-with-guard.json` | Global observe, with the dangerous subset denied |

`test/examples.test.mjs` validates every template, so they cannot rot.

## Check before and after

```
node tools/check.mjs --policy path/to/policy.json --validate
node tools/check.mjs --tool pwsh --args '{"command":"Remove-Item D:\\work\\a.txt -Force"}' --json
```

The first answers "is this file valid" (exit 0 valid, 1 not). The second answers
"what would the gate do right now" without touching the audit — the same
`evaluate()` the host uses. Use `--cwd` to reproduce a workspace-scoped answer.

## Common mistakes

| Mistake | Result |
|---|---|
| `allow` with `version: 1` | Whole file rejected (`allow-requires-v2`); last good policy keeps running |
| `observe` with `version: 1` | Same (`observe-requires-v2`) |
| `entries` with `version: 1` | Same (`entries-require-v2`) |
| Both `rules.quiet` and `rules.destructive.workspaceQuiet` | Rejected (`quiet-duplicate`) |
| `selfProtect.mode: "off"` | Rejected (`self-protect-not-disableable`) |
| `critical.mode: "observe"` | Rejected (`critical-mode-invalid`) |
| A regex without `^` | Rejected (`command-matches-unanchored`) |
| A relative path in `when` | Rejected (`path-shape`) |

## Limits worth knowing

`observe` and `allow` do not make the gate safer; they make it quieter. Nothing
here is a sandbox: a process outside the host, or a command that is obfuscated
past the parser, is out of scope. `docs/DSH-API.md` lists what the plugin
depends on and what happens if the host changes it.
