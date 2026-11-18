# dsh-guardrails

**English** | [中文](README.zh-CN.md)

A small, dependency-free guardrail for **DSH** that gates risky tool calls *before* they run,
and leaves a local audit trail of what was gated.

- **Host-native**: a DSH plugin listening on `tools/pre-execute`. No daemon, no proxy, no extra process.
- **Deterministic**: path and pattern rules only. No model calls, no network, no judgment from the same
  model that proposes the action.
- **Auditable**: every gated call writes one JSONL line; secrets are never written in clear text.
- **Windows-only**, 1.x. Path semantics assume Windows (`~`, `%VAR%`, `$env:VAR`, backslashes).

**Status**: v1.5.1. The critical tier and the audit v2 stream were verified live on Windows 11
(2026-11-15): denied calls return no card and never execute, an approved call produces the full
`requested → delivered → outcome → executed` chain with a payload, and `--verify` validates the hash chain.
Since then the ranked engine (`version: 2`), custom `entries`, `observe`, the two-stage dry run, workspace
quiet and the `check` CLI were added and exercised live; `CHANGELOG.md` lists each step and
`design/p3-policy-v2.md` records what was verified how.

## Documentation

| Page | Read it when |
|---|---|
| [docs/DETAIL.md](dsh-guardrails/docs/DETAIL.md) ([中文](dsh-guardrails/docs/DETAIL.zh.md)) | You want to know what a card says and why |
| [docs/POLICY.md](dsh-guardrails/docs/POLICY.md) ([中文](dsh-guardrails/docs/POLICY.zh.md)) | You want to change behaviour — modes, `entries`, templates |
| [docs/ARCHITECTURE.md](dsh-guardrails/docs/ARCHITECTURE.md) | You are changing the code and need the file map |
| [docs/DSH-API.md](dsh-guardrails/docs/DSH-API.md) | You are upgrading DSH, or something went quiet |
| [CHANGELOG.md](CHANGELOG.md) ([中文](CHANGELOG.zh-CN.md)) | You want the history and the reasons |
| [SECURITY.md](SECURITY.md) | You found a way through the gate |
| [CONTRIBUTING.md](CONTRIBUTING.md) | You want to add a rule or change the policy format |
| [design/](design/) | You want the measurements and the rejected alternatives |

## Why

An agent is most dangerous at the boundary between a sentence and an action: it can rewrite its own
configuration, delete a directory it misread, or paste an API key into a log. Prompt-level instructions
do not stop any of that. This gate sits on the last hop before execution and asks a human — or refuses.

## Rules

| Rule | Fires when | Default |
|---|---|---|
| **R1** Protect DSH's own home | A write verb whose operand is inside `~/.dsh` or `~/.agents`, including a target named in `apply_patch` text; any `plugin_manager` operation | ask |
| **R1 self** Guard the plugin | A write whose operand is this plugin's own source directory — including a path or a `Move to` destination inside an `apply_patch` body | ask |
| **R2** Destructive operations | Delete/move/rename in command position, `robocopy /MIR`, `git reset --hard`, `git clean -f`, `format`, `diskpart`, `reg add/delete/import`, `sc create/config/delete`, `schtasks`, `netsh advfirewall`, `Set-MpPreference`, `takeown`, `icacls`, `chkdsk /f`, `dism /remove-*`, `sfc /scannow` | ask |
| **R2 critical** (severity) | Formatting/partitioning a disk, `diskpart /s`, boot configuration writers (`bcdedit`, `bootrec`, `vssadmin delete`, `wbadmin delete`, `reagentc`), deleting `HKLM\SYSTEM` or `HKLM\SAM`, writing/deleting/moving anything inside `%SystemRoot%` or `%ProgramFiles%`, `takeown`/`icacls` aimed at those directories | deny |
| **R3** Secrets in tool arguments | Ark / `sk-` / `AKIA` / `ghp_` / `AIza` / `xox` / bearer tokens / private key blocks / `key=...` assignments | deny in shell commands, ask on file writes (label only) |
| **E** Your own `entries` | Tool, workspace, target and command conditions you wrote | whatever you set |

Each band can be `ask`, `deny` or `off`; engine `version: 2` adds `observe` and `allow` (plus `entries`).
With `version: 2` the bands are ranked `deny > ask > observe > allow` and the strictest hit wins, so a
user `allow` never overrides a built-in `ask`.

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
is therefore refused outright; a file write, whose content is never echoed, still asks. Under
`version: 2`, `secrets.mode: "observe"` records the call instead — the payload is stored redacted
(`<redacted:openai>`) and the hash is computed over the redacted text only.

Self-protection exists because the gate's own rules are the easiest thing to weaken. It accepts
`ask`, `deny`, or (v2) `observe`; it never accepts `off` — a switch that can be turned off by the file it
protects is not a guardrail.

## How a call is judged

```
tool call ──▶ evaluate(policy, call, env) ──▶ null ──────────────▶ allow
                                              └─▶ { rule, mode } ──▶ audit + heartbeat
                                                                     ├─ ask  → approval prompt (once)
                                                                     └─ deny → refused, reason returned
```

Under `version: 2` every band reports and the strictest wins; the runner-up hits land in the audit's
`reasons` (at most eight). Then two post-steps may act: **workspace quiet** can turn one routine delete
into a silent allow, and the **dry run** can refuse the first attempt of a destructive command whose card
could not describe it.

The plugin is **fail-open**: if policy parsing or rule evaluation throws, the call proceeds. A guardrail
must not brick the tool chain. The one exception is the critical tier: when evaluation breaks, a shell
command that still matches the critical matcher is refused instead of run (`rules.critical.failClosed`,
on by default). If the plugin itself never mounts, the host simply runs unguarded — `loaded.json` exists
so that this state is detectable (see below), and it now records `surface: "ok" | "degraded"` so a host
shape change shows up instead of looking healthy.

## Install

Requires DSH on Windows. Developed against DSH desktop `0.2.2-rc.1` and verified on a clean machine with
`0.2.2-rc.3`, both on Windows 11; other host
versions are untested. The package declares `engines.dsh: ">=0.2.0-0"`, but the host was not observed
enforcing it. The package is not on a registry yet, so link a checkout into a profile:

1. Clone the repository — `git clone https://github.com/VladimirKuzen/DSH-guardrails.git`. It is private while
   it is being prepared for release, so this step needs access to it.
2. Add the dependency to `%USERPROFILE%\.dsh\profiles\<profile>\package.json`:

   ```json
   "@vlad/dsh-guardrails": "link:<absolute path to the checkout>\\dsh-guardrails"
   ```

3. Add `@vlad/dsh-guardrails` to `dsh.profile.bundles` in the same file.

> **The runtime is lazy.** DSH unpacks its bundled `node` and `pnpm` on first need, not on first launch: a
> fresh install does not create `%USERPROFILE%\.dsh\dsh-runtimes\` just by being started. Use the host once
> with a tool that shells out, or let the plugin manager install anything, and the directory appears. If it
> stays missing, the installer ships the same payload at
> `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\`: copy it to
> `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\`, or install Node LTS plus `pnpm` yourself and use
> those instead of the bundled ones.

4. Run `pnpm install` in the profile directory. A clean machine has no `pnpm` (or `node`) on `PATH` — DSH
   brings its own runtime — so call that copy:

   ```powershell
   $deps = (Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes\*\dependencies" -Directory)[0]
   & "$($deps.FullName)\node\bin\node.exe" "$($deps.FullName)\pnpm\bin\pnpm.mjs" install
   ```

5. Restart DSH. Host plugins do not hot-reload.

Verify it mounted: `~/.dsh/guardrails/loaded.json` should have a fresh mtime, a `version` matching
`dsh-guardrails/package.json`, and `surface: "ok"`. **Do not trust the pid** — the host process can be
replaced while the gate keeps working in a new one. Freshness plus version (plus surface) is the signal.

## Configure

| What | Where |
|---|---|
| Policy | `~/.dsh/guardrails/policy.json` — re-read within 2 seconds, no restart |
| Policy override | Environment variable `DSH_GUARDRAILS_POLICY` |
| Audit | `~/.dsh/guardrails/audit/v2/` — one JSONL per day, payloads, and a hash chain |
| Liveness | `~/.dsh/guardrails/loaded.json` |

```json
{
  "version": 2,
  "enabled": true,
  "audit": { "format": "v2", "maxPayloadBytes": 65536 },
  "rules": {
    "protectDshHome": { "mode": "ask", "roots": ["~/.dsh", "~/.agents"] },
    "critical":       { "mode": "deny", "patterns": [], "failClosed": true },
    "destructive":    { "mode": "ask", "patterns": [],
                        "dryRun": { "enabled": false, "minChars": 400, "minStatements": 3, "dynamicTarget": true } },
    "secrets":        { "mode": "ask", "patterns": [] },
    "selfProtect":    { "mode": "ask", "paths": [] },
    "quiet":          { "enabled": false,
                        "roots": ["D:\\work\\guardrails"],
                        "paths": ["_scratch", "build", "dist"],
                        "alwaysAsk": [".git", ".", ".."] }
  },
  "entries": [
    { "id": "no-force-push", "tool": ["pwsh", "bash"], "mode": "deny",
      "when": { "commandMatches": "^\\s*git\\s+push\\b[^|;]*--force" } }
  ]
}
```

`D:\work\guardrails` in the example, and the paths in the commands on this page, are placeholders — swap in
a directory that exists on your machine.

`patterns` appends your own regular expressions to the built-in lists. `critical.patterns` adds your own
regexes to the hard-stop tier; `critical.failClosed` keeps that tier closed when evaluation itself throws.
A corrupt policy file is ignored in favour of the last good copy — the gate never disappears because of a
bad edit — and one `config-invalid` record says which field was wrong. `audit.format: "v1"` falls back to
the old single-file log.

`rules.quiet` (off by default) turns the routine cleanup of one temp file into a silent allow: the shell
call has exactly one statement and one target, no `-Recurse`, no wildcard, and an absolute path under one
of `roots` and under one of `paths`. `-Force` is allowed when those hold. Anything else still asks; R1,
R3 and the critical tier are untouched. If a session cwd is known and lies outside `roots`, quiet
disables itself and writes one `config-invalid` record; when no cwd is known, `entries` that use
`cwdUnder` do not match and one `config-invalid` record says so. The old location
(`rules.destructive.workspaceQuiet`) still works and is migrated on load, but keeping both is rejected.

`entries` are the place for your own rules; `mode: "allow"` there is a declaration that shows up in the
audit, not an exemption. See [docs/POLICY.md](dsh-guardrails/docs/POLICY.md) for the three-step way to
loosen something without losing the trail, and `dsh-guardrails/examples/policy/` for templates that are
validated by the test suite.

## Ask the gate without asking the host

```powershell
'{"command":"Remove-Item D:\\work\\a.txt -Force"}' |
  node dsh-guardrails/tools/check.mjs --tool pwsh --args - --json
node dsh-guardrails/tools/check.mjs --policy .\policy.json --validate
```

On Windows PowerShell the arguments have to come through stdin (`--args -`): PowerShell re-quotes inline
arguments, so `--args '{"command":"…"}'` can arrive mangled. `cmd.exe` accepts the inline form.

Exit codes: `0` allow, `2` needs approval, `3` refused, `1` usage or policy error — and `1` never means
allow. It runs the same `evaluate()` and the same quiet post-step as the host; it writes no audit and
touches no heartbeat.

## Audit

Every gated call becomes a short chain of records sharing one `id`: `requested` at the gate, `delivered`
when the approval service accepts the question, `outcome` when the user or the guard decides, and
`executed` when an approved call really ran. Silent paths write `allowed` (with `quiet: "workspace"`) or,
under `version: 2`, `observed`. Records are linked by `prevHash`, so an edited or truncated line is
detectable; the command text is stored under `payload/`, with secret-shaped spans replaced by
`<redacted:label>` and **no hash at all** for a denied secret. `cwd` and `cwdSource`
(`session` / `tool` / `null`) record the working directory the decision was made in; `reasons`,
`entryId` and `reasonsTruncated` say why and by which band; misconfiguration writes `config-invalid`
with a `reason` and `detail`.

Read it offline:

```powershell
node dsh-guardrails/tools/audit-report.mjs            # last 20 events
node dsh-guardrails/tools/audit-report.mjs --stats     # counts by event / rule / outcome
node dsh-guardrails/tools/audit-report.mjs --verify    # hash-chain check, exit 1 when broken
node dsh-guardrails/tools/audit-report.mjs --event observed --rule R1
```

## Repository layout

| Path | Purpose |
|---|---|
| `dsh-guardrails/` | The plugin: `index.js` (host wiring), `rules.js` (pure decision logic), `lib/` (matchers, facts, cards, audit), `policy.schema.json` |
| `dsh-guardrails/docs/` | `DETAIL`, `POLICY`, `ARCHITECTURE`, `DSH-API` (each with a Chinese twin where it makes sense) |
| `dsh-guardrails/examples/policy/` | Policy templates, validated by the test suite |
| `dsh-guardrails/i18n/` | Card strings (`zh.json`, `en.json`) |
| `dsh-guardrails/locale/` | Plugin metadata the **host** reads: title, subtitle, and which `detail` page to open. Not used by the gate; do not delete |
| `dsh-guardrails/test/` | Unit, contract, CLI and mount-level tests |
| `dsh-guardrails/tools/` | `check.mjs` (ask the gate from a terminal), `audit-report.mjs` (offline reader) |
| `design/` | Decision records: measurements, rejected alternatives, known gaps |
| `CHANGELOG.md` | Release history — English and Chinese versions |
| `SECURITY.md` | Supported versions, what is in scope, how to report privately |
| `CONTRIBUTING.md` | Ground rules, layout, how to add a rule without breaking the protocol |
| `scripts/` | Maintainer tooling — audit redaction, snapshot/restore, health check. **Kept local (git-ignored), not part of this repository** |

Maintainer tooling exists because audit files contain command text and paths. It snapshots and redacts
them locally, then encrypts the result with Windows DPAPI (bound to the current user account).

## Development

No build step, no runtime dependencies. Tests run directly:

```powershell
npm test   # runs the eighteen test files in order
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
- **Approval surfaces may not match the plan.** The host renders the decision prompt and deliberately does
  not hand the plugin a structured body; the plugin can only supply the title line.
- **Audit covers gated calls only.** Calls that never hit a rule are not logged, and a call the gate never
  saw leaves no trace. Records prove what the plugin decided and what the host executed, not what happened
  outside DSH.
- Windows only.

## Uninstall

Remove `@vlad/dsh-guardrails` from the profile's `dsh.profile.bundles` and its `dependencies`, then
restart DSH. Existing audit files are left in place; delete them yourself if you want them gone.

## License

MIT.

## Acknowledgements

Built with DeepSeek Harness in an agent-assisted workflow: the agent drafted code, tests and
documentation under the maintainer's direction. Commit authorship, release decisions and every
live acceptance run remain with the maintainer.

