# Changelog

**English** | [中文](CHANGELOG.zh-CN.md)

Notable changes to the guardrail, newest first. Versions follow `dsh-guardrails/package.json`.

## [Unreleased]

- Release paperwork: [SECURITY.md](SECURITY.md) states supported versions (`1.x`; Windows-only out of
  scope), what counts as a bypass, what is a documented limit, and that reports go through GitHub's
  private advisory instead of a public issue. [CONTRIBUTING.md](CONTRIBUTING.md) has the ground rules,
  the file map, the six steps for adding a rule, and the rules for changing `policy.schema.json`.
- New `test/docs.test.mjs`: `i18n/en.json` and `i18n/zh.json` must carry the same keys and the same
  `{placeholder}` sets, and every relative link in the Markdown tree must resolve. The link test asserts a
  minimum number of links scanned, so a walker that silently matches nothing fails instead of passing.
- No machine-local paths remain in tracked files: the README's `quiet` example, the `design/` notes and
  three test files now use `D:\work\...`, `%USERPROFILE%\...` or `%LOCALAPPDATA%\...` placeholders.
  `test/self-protect.test.mjs` derives the workspace from the checkout (the parent of `pluginRoot()`)
  instead of hard-coding it, so the case no longer depends on where the repository lives.
- `README.md` / `README.zh-CN.md` no longer call the plugin "pre-1.0", and the test-file count in the
  development section now matches reality: 18 files, 404 cases.
- `design/p4-release.md` records the four decisions, the stages, the history rewrite and the evidence behind
  each claim.
- Package metadata: `repository` (with `directory: "dsh-guardrails"`, since the package sits in a
  subdirectory), `homepage` and `bugs` point at the GitHub repository. `private` stays on until the
  repository becomes public, so nothing is publishable yet. The README now names the host version this was
  tested on: DSH desktop `0.2.2-rc.1`.

## [1.5.0] — 2026-11-17

- Documentation set: [docs/POLICY.md](dsh-guardrails/docs/POLICY.md) covers the modes, `entries`, the
  three-step way to loosen a band and the templates; [docs/ARCHITECTURE.md](dsh-guardrails/docs/ARCHITECTURE.md)
  is the file map, the per-call path and where state lives; [docs/DSH-API.md](dsh-guardrails/docs/DSH-API.md)
  lists every host interface this depends on, what breaks when one moves, and the five checks after a DSH
  upgrade. `README.md` was rewritten for v2 and now opens with a documentation map; the layout section
  names `lib/`, `docs/`, `i18n/`, `examples/` and `locale/` (the last one is plugin metadata the host
  reads — keep it).
- Policy templates under `dsh-guardrails/examples/policy/` (`minimal-v1`, `observe-first`, `tighten`,
  `relax-with-guard`) are shipped in the package and validated by `test/examples.test.mjs`, so they cannot
  drift from the schema.
- `loaded.json` records `surface: "ok" | "degraded"`. When `ctx.on` is missing the mount writes the
  degraded state, logs one error and returns instead of pretending to be mounted — a host shape change now
  shows up instead of looking healthy.
- `cwdUnder` entries read the workspace from the session header (`session.header.cwd`; `meta.cwd` and a
  shell call's `workdir` are the fallbacks). It used to read `session.cwd`, which this host never populates,
  so a `cwdUnder` entry was silently inert. When a cwdUnder entry exists but no cwd can be resolved, one
  `config-invalid` record now says so instead of staying quiet.
- `config-invalid` audit records keep `reason` and `detail`. They were being dropped by the writer's field
  whitelist, leaving a record that said something went wrong but never what.
- The card follows a literal held in a variable: `$p = 'D:\work\a.txt'; Remove-Item $p` now names
  `D:\work\a.txt` (and no longer asks for a dry run) instead of reporting an unnamed target. An `$env:`
  value is still not guessed — it is not written in the command.
- Workspace quiet now lives at `rules.quiet`; `rules.destructive.workspaceQuiet` keeps working as an alias
  (a file that sets both is refused, so there is never a question of which copy wins). The setting decides
  whether a card is shown at all, so it is not a property of the destructive matcher. An `observe` entry
  matching the same call no longer switches quiet off: weaker matches are recorded in `reasons`, they do
  not veto.
- R1 self-protection (`rules.selfProtect`): a write, or a shell command carrying a write verb, that targets
  the plugin's own directory (plus any extra root in `paths`) now asks before running. `apply_patch` is
  covered as well by reading its `*** Update File:` targets out of the patch text. The mode accepts only
  `ask` or `deny`: a switch that the file it protects could turn off is not a gate. It raises the cost of
  editing the gate through a tool; it is not a sandbox — hand edits, other processes and an `fs` write
  inside the plugin still bypass it.
- Policy files are validated against `policy.schema.json` before they are merged: unknown keys (typos) are
  rejected, `version` above 2 is refused, and a file that fails validation is ignored — the previous good
  policy stays live, with one `config-invalid` audit record instead of a silently weakened gate.
- The policy schema ships in the package (`files`), so an installed copy can validate too.
- Optional dry run before an unreadable destructive command (`rules.destructive.dryRun`, off by default):
  when the target is a variable, the command is long, or it chains several destructive steps, the first
  attempt is refused with an instruction to list the exact paths first; the retry — same session, same
  command shape — is carded as usual, with `dry run was requested first` on the card. It is a nudge: a
  retry clears it and the gate cannot tell whether a listing was produced.
- The card now names the worst destructive action in a command instead of the first one recognized:
  `New-Item … ; Remove-Item …` reads as a delete rather than "create directory". A target set by a variable
  is reported as such (`target set by a variable`, or `see the read-only listing above` after a dry run)
  instead of the target segment disappearing.
- Policy engine v2 (`"version": 2`): every rule that matches is now collected, ranked
  (`deny` > `ask` > `observe` > `allow`) and resolved to one winner instead of stopping at the first band.
  `version: 1` files take the old path unchanged.
- `observe` records a hit without blocking or carding (`event: "observed"`); `allow` lets a block through and
  records `event: "allowed"`. Both exist only under `version: 2`; under `version: 1` `observe` is rejected at
  load time and `allow` is still treated as `ask`.
- Custom `entries`: a tool plus conditions (`cwdUnder` / `targetUnder` / `commandMatches`, all must hold) plus
  a mode. They rank with the built-in rules, so an `entries.deny` can tighten a block that was lowered, while
  `entries.allow` never clears a built-in hit. The card says the rule in words; the audit keeps `rule: "E"`
  and `entryId`, plus every hit in `reasons[]` (at most 8).
- A secret that was seen anywhere in the call keeps the R3 payload shape (hash only, no stored text) even when
  a stricter rule wins the ranking.
- `selfProtect` accepts `observe` under `version: 2` as a development truce: edits to the gate's own source are
  recorded instead of carded. `off` and `allow` remain rejected — the switch a protected file could turn off is
  not a gate — and this is not a mode to ship in.
- Shell writes to a protected path are caught even when the path reaches the write verb through a variable or a
  later statement: the same-statement rule missed two real `policy.json` writes on 2026-11-17 (no audit record at
  all, only the sandbox approval). `WriteAllText` and friends now count as write verbs too.
- A protected path counts only as the operand of a write verb: the check parses statements, finds each write verb,
  and resolves its own arguments (a literal path, or a variable assigned one earlier). A path that merely appears
  in the command is no longer a target, so `& "…\.dsh\…\node.exe" x.mjs; Set-Content out.txt` and
  `Get-Content .dsh\…; Set-Content $env:TEMP\out` stop carding, and the card stops naming a program as the object
  being written (five such cards on 2026-11-17). The `±400`-character window that produced them is gone.

- `dsh-guardrails check` (also `node tools/check.mjs`) answers "would this call be stopped?" with an exit
  code — `0` allowed, `2` would be carded, `3` refused, `1` usage or policy error — through the same engine and
  the same quiet step the host uses. `--args -` reads the arguments from stdin (PowerShell mangles inline
  JSON), `--cwd` sets the base for relative paths, `--json` prints the winner plus `reasons[]`. It writes no
  audit records: it is a question, not a call.
- The workspace-quiet decision moved into `lib/finalize.js`, shared by the host, the contract runner and the
  CLI, so those three cannot drift apart again.
- `test/engine-v2.test.mjs` was missing from the `npm test` chain; its 17 tests are wired in now, and the CLI
  replays the whole contract table as a second runner.
- A secret is never hashed: a hash of a low-entropy secret (`password=hunter2`) is a dictionary oracle, so a
  secret record now carries `payloadBytes` only. Under `observe` the secret run is replaced by
  `<redacted:label>` before the payload is written, a re-scan that still matches drops the payload entirely,
  and `redacted` records which shapes were removed (`lib/redact.js`, `test/redact.test.mjs`).
- `reasonsTruncated` marks a record whose `reasons[]` was cut at 8, so a reader can tell "one band matched"
  from "ten did".

## [1.4.0] - 2026-11-15

- Optional workspace quiet (`rules.destructive.workspaceQuiet`, off by default): a shell call that deletes
  or moves exactly one target, with no `-Recurse` and no wildcard, at an absolute path under one of the
  configured `roots` and under one of the `paths`, is allowed without a card. `-Force` is fine when those
  hold. R1, R3 and the critical tier are untouched, and any other shape still asks.
- A silent allow is recorded as an `allowed` event (with `quiet: "workspace"` and the payload), so the
  audit still answers "what was allowed without asking" in v1 mode too.
- If the session cwd is known and outside `roots`, quiet turns itself off and writes one `config-invalid`
  record; when no cwd is known that cross-check is skipped and the absolute roots decide alone.

## [1.3.2] - 2026-11-15

- Audit records now carry `cwd` plus `cwdSource` (`session`, `tool` or `null`): the session working
  directory when the session has one, otherwise the shell tool's explicit `workdir`. The host process
  directory is deliberately never used — it is the install directory, not the workspace.

## [1.3.1] - 2026-11-15

- Fix the hash chain: `canonicalJson` now mirrors `JSON.stringify` for undefined values, so a record whose
  `facts` carried an empty `severity` no longer fails verification after it is read back from disk. The
  first live run exposed this — records written by 1.3.0 fail `--verify` and should be rotated.
- Regression test: a record with undefined fields still verifies after a JSON round-trip.

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
