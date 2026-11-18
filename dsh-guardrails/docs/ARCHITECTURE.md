# Architecture

How the pieces fit, so a change lands in the right file. It describes the
checkout as of `1.5.0`; the file names matter, line numbers do not.

## Two trees

This repository holds a plugin and the material around it. Only part of it is
published as the package.

| Path | Job | Shipped? |
|---|---|---|
| `dsh-guardrails/index.js` | Host wiring: registers the hooks, owns the policy cache, the pending map and the audit writes | yes |
| `dsh-guardrails/rules.js` | `evaluate(policy, call, env)` — pure decision, no IO, no logging | yes |
| `dsh-guardrails/lib/rules/kit.js` | Shared matchers: `expandPath`, `pathOf`, `isUnder`, write-verb operands, `DEFAULT_DESTRUCTIVE`, `DEFAULT_SECRETS` | yes |
| `dsh-guardrails/lib/rules/r1-home.js` | R1: writes into `~/.dsh` / `~/.agents`, and shell commands that write a path there | yes |
| `dsh-guardrails/lib/rules/r1-self.js` | R1 self: writes into this plugin's own source, including `apply_patch` bodies | yes |
| `dsh-guardrails/lib/rules/r2-destructive.js` | R2: the critical tier first, then the destructive pattern list | yes |
| `dsh-guardrails/lib/rules/r3-secrets.js` | R3: secret shapes in arguments; deny for shell, ask for file tools | yes |
| `dsh-guardrails/lib/rules/entries.js` | User-defined `entries` (engine v2 only) | yes |
| `dsh-guardrails/lib/rules/quiet.js` | Workspace quiet: the "one routine delete needs no card" rule | yes |
| `dsh-guardrails/lib/facts.js` | What the call would do: `kind`, `target`, `count`, `dynamic`, `protectedHit` | yes |
| `dsh-guardrails/lib/describe.js` | Card text from facts + verdict, in the caller's locale | yes |
| `dsh-guardrails/lib/finalize.js` | The post-decision pass shared by the host, the contract runner and the CLI (`factRoots`, `applyWorkspaceQuiet`) | yes |
| `dsh-guardrails/lib/dry-run.js` | Two-stage dry run: when a card could not describe the call, refuse the first attempt | yes |
| `dsh-guardrails/lib/redact.js` | Replaces secret-shaped spans with `<redacted:label>` before a payload is stored | yes |
| `dsh-guardrails/lib/policy/merge.js` | Defaults → file → entry config, plus `applyAliases()` for the legacy `workspaceQuiet` key | yes |
| `dsh-guardrails/lib/policy/validate.js` | Hand-written schema + semantic check; no dependency | yes |
| `dsh-guardrails/lib/audit/v2.js` | JSONL records, hash chain, payload files | yes |
| `dsh-guardrails/policy.schema.json` | The policy shape, for editors and for `validate.js` | yes |
| `dsh-guardrails/cordis.patch.yml` | The bundle patch that inserts this plugin | yes |
| `dsh-guardrails/locale/en.json`, `locale/zh.json` | **Plugin metadata the host reads**: title, subtitle, and the `detail` page to open from the plugin UI | yes |
| `dsh-guardrails/i18n/en.json`, `i18n/zh.json` | Card strings used by `lib/describe.js` — a different file with a different job | yes |
| `dsh-guardrails/docs/` | This file, `DETAIL.md`, `DSH-API.md`, `POLICY.md` | yes |
| `dsh-guardrails/examples/policy/` | Copy-paste policy templates, validated by `test/examples.test.mjs` | yes |
| `dsh-guardrails/tools/check.mjs` | `dsh-guardrails check` — asks the same `evaluate()` from a terminal | yes |
| `dsh-guardrails/tools/audit-report.mjs` | Offline reader for the audit stream | yes |
| `dsh-guardrails/test/` | Unit, contract, CLI and mount-level tests | no |
| `design/` | Decision records: why a rule exists, what was measured, what was rejected | no |
| `README.md`, `CHANGELOG.md` | Entry point and history (English + Chinese twins) | no |
| `scripts/` | Maintainer tooling for redacting and snapshotting audit files | no |

The `locale` / `i18n` split confuses people: `locale/*.json` is the plugin
listing (the host shows `meta.title` and opens `meta.detail`), while
`i18n/*.json` is what the plugin itself prints on a card. Editing the wrong one
changes nothing visible.

## Layers

```
index.js            host hooks, cache, pending map, audit, heartbeat
  rules.js          evaluate(): decide, in band order, one winner
    lib/rules/*     one matcher per band; each returns { rule, mode, reason }
    lib/rules/entries.js   user rules, engine v2
  lib/facts.js      what the call would do (needed by quiet and by the card)
  lib/finalize.js   quiet, applied to the winner
  lib/describe.js   card text
  lib/audit/v2.js   the record and its payload
```

`rules.js` stays pure on purpose: the CLI imports it, the tests import it, and
`evaluate()` must give the same answer for the same input everywhere. Anything
that needs the filesystem (`statSync`, `realpath`, `readFileSync`) lives in
`index.js`, `lib/facts.js` or `lib/finalize.js`.

## One call, end to end

1. The host calls the `tools/pre-execute` listener with `(exec, next)`.
2. `index.js` reads the policy. The file is re-read at most once every two
   seconds and only when its mtime changed; a file that fails to parse or
   validate is ignored in favour of the last good copy, and the problem is
   reported once (`config-invalid` in the audit, one `logger.warn`).
3. `evaluate(policy, exec, env)` returns `null` (nothing matched) or a verdict
   `{ rule, mode, reason }` plus, under engine v2, `reasons`, `secretHit` and
   `entryId`.
4. `collectFacts()` describes the call for the card and for quiet.
5. `applyWorkspaceQuiet()` may turn an ordinary R2 `ask` into a silent allow.
6. The two-stage dry run may turn an `ask` into a refusal and remember the
   command fingerprint for this session.
7. The verdict becomes one of: `next()` (allow), an approval prompt (`ask`,
   with `displayReason` from `describe()`), or a refusal with a reason string
   the model can read (`deny`).
8. `tools/post-execute` records `executed` only when the outcome was
   `allowed-once`, so a denial that also reaches post-execute is not counted as
   a run.

`session/event` keeps just enough session state to expire pending approvals.

## State, all local

| State | Where | Lifetime |
|---|---|---|
| Policy cache | in memory | re-read at most every 2 s; survives a bad edit by keeping the last good copy |
| Pending approvals | in memory, keyed by `callId` | expired by `PENDING_TTL_MS` |
| Dry-run memory | in memory, per session | 50 fingerprints per session |
| Audit records | `~/.dsh/guardrails/audit/v2/YYYY-MM-DD.jsonl` | append-only, hash-chained |
| Payloads | `~/.dsh/guardrails/audit/v2/payload/…` | only for calls that were allowed or observed |
| Liveness | `~/.dsh/guardrails/loaded.json` | rewritten on mount and on every audited call |

The liveness file is not a timer. A quiet process that receives no tool calls
leaves the file untouched, so use freshness **plus** the version string, and
never the pid: the host can be replaced while the plugin keeps working.

## Engine v1 and v2

`version` in the policy file selects the semantics.

- **v1** (missing or `1`): each band is tried in order and the first hit wins.
  `observe` and `allow` do not exist; a configured `allow` is clamped to `ask`.
- **v2**: every band reports, candidates are ranked
  `deny > ask > observe > allow`, and the strictest wins; ties keep band order.
  `observe` records without asking, `entries` are read, and a `deny` from any
  band beats an `allow` from a user entry.

The order is fixed: R3 → R1 home → R1 self → R2 critical → R2 destructive →
`entries`, then quiet, then the dry run.

## Verifying a change

- `npm test` runs every file under `test/` in order (`node <file>`, not
  `node --test`, because the sandbox forbids the child processes that runner
  spawns).
- `'{"command":"..."}' | node tools/check.mjs --tool pwsh --args - --json` answers
  the same question the host would, without touching the audit.
- A live check still needs a host restart: plugins are evaluated in-process and
  do not hot-reload. `policy.json` is the exception — it is re-read in place.
