# Contributing

Thanks for looking. This is a small, opinionated plugin; the notes below are what keeps it reviewable.

## Ground rules

- **Windows only, 1.x.** Every judgement depends on Windows path and shell semantics (`~`, `%VAR%`,
  `$env:VAR`, backslashes, PowerShell). Cross-platform support would be a 2.0 redesign, not a patch.
- **No runtime dependencies, no network, no model calls.** `evaluate()` stays pure: a policy, a tool call
  and an environment in, a verdict out.
- **Fail open, except the critical tier.** A crash inside the gate must not brick the user's tools, but
  every silent path has to leave an audit record.
- **Do not weaken a default silently.** A changed pattern needs a test that fails before the change and a
  `CHANGELOG` line that says why.
- **Language.** Code, comments, identifiers and file names are English. Card text and `.md` prose may be
  Chinese, and every user-facing document has a Chinese twin (`README`, `CHANGELOG`, `docs/DETAIL`,
  `docs/POLICY`) — update both in the same commit.
- **One intent per commit**, imperative subject plus one line saying *why*. Run `git status` first; the
  working tree has ignored scratch directories.

## Layout

| Path | What lives there |
|---|---|
| `dsh-guardrails/index.js` | Cordis plugin entry: hooks, policy loading, audit writes, card text |
| `dsh-guardrails/rules.js` | Band order, engine v1/v2 dispatch; returns `{ rule, mode, reason, label? }` or `null` |
| `dsh-guardrails/lib/rules/kit.js` | Shared helpers plus `DEFAULT_DESTRUCTIVE`, `DEFAULT_SECRETS`, the critical matcher |
| `dsh-guardrails/lib/rules/r1-home.js`, `r1-self.js` | R1: DSH's own home, the gate's own source |
| `dsh-guardrails/lib/rules/r2-destructive.js` | R2: destructive commands and the critical tier |
| `dsh-guardrails/lib/rules/r3-secrets.js` | R3: secrets in tool arguments |
| `dsh-guardrails/lib/rules/entries.js`, `quiet.js` | User `entries` (v2), workspace-quiet roots |
| `dsh-guardrails/lib/facts.js` | Extracts paths, commands, shells from a tool call |
| `dsh-guardrails/lib/describe.js` | Card titles/actions, i18n fallback |
| `dsh-guardrails/i18n/en.json`, `zh.json` | Every card string, keyed |
| `dsh-guardrails/policy.schema.json` | The policy protocol; validated by `tools/check.mjs` |
| `dsh-guardrails/test/` | One `node:test` file per area; fixtures under `test/fixtures/` |
| `dsh-guardrails/docs/` | Architecture, host API, policy guide, card reference |

## Adding a rule

A rule is a matcher plus a card. In order:

1. **Matcher.** Extend the table in `lib/rules/kit.js` (`DEFAULT_DESTRUCTIVE`, `DEFAULT_SECRETS`, or the
   critical matcher) or add a module and wire it into the band order in `rules.js`. The function must be
   pure and total: never throw, return `null` when nothing matches. A band returning `{ rule, mode,
   reason }` is all the host needs; the critical tier also sets `severity` and `category`.
2. **Fixtures.** Add a case to `test/fixtures/contract-cases.json`: the tool call, the environment, the
   expected verdict. A documented bypass goes in with `knownGap: true` so the suite records that it is
   known, not that it is fixed. `contract.test.mjs` and `cli.test.mjs` both read this table, so a new case
   exercises the library and the CLI at once.
3. **Unit test.** If the matcher has internal branches (path expansion, quoting, scripts), add a focused
   case to `test/rules.test.mjs` or a new file.
4. **Card.** Add the string to `i18n/en.json` and `i18n/zh.json` under the same key, and a fallback in
   `lib/describe.js`. `test/docs.test.mjs` fails if the two key sets or the `{placeholder}` sets differ.
   `locale/*.json` only carries metadata (name, description) for the plugin list.
5. **Docs.** `docs/DETAIL.md` and `docs/DETAIL.zh.md` explain what the card means; `docs/POLICY.md` and
   `POLICY.zh.md` only if the user can change it. Add a `CHANGELOG.md` and `CHANGELOG.zh-CN.md` line under
   the version it ships in. `test/docs.test.mjs` checks that every relative link in tracked Markdown
   resolves.
6. **Run the suite** (below) on Windows. If the change touches `index.js`, restart DSH and confirm
   `~/.dsh/guardrails/loaded.json` shows the new `version` with `"surface": "ok"` — the plugin does not
   hot-reload, and a failed load is silent.

## Running tests

There is no build step and no `npm` requirement:

```powershell
node dsh-guardrails\test\rules.test.mjs
```

One file at a time, from the repository root. `npm test` runs every file the same way; the suite is also
what CI runs on `windows-latest` with Node 24. Do not reach for `node --test` with a directory argument or
for child processes inside tests: the gate runs under a sandbox that refuses process spawning, and a test
that shells out will fail for the wrong reason.

Expected: all green. If you are changing a verdict, say in the PR which fixture changed and why, and paste
the before/after line of the audit record.

## Changing the policy format

`policy.schema.json` and the audit field names are the protocol other people's files depend on.

- Within `1.x` the schema only grows: new optional keys, new enum values. A file that validated before
  must still validate.
- Renaming or removing a key, or changing a verdict for a file that did not change, is a `2.0` change with
  a migration note.
- Validate a policy before shipping it:
  `node dsh-guardrails\tools\check.mjs --policy <file> --validate`.

## Documentation

`README.md` is the front door and is checked against the tree; keep the file map honest when you add a
file. `docs/ARCHITECTURE.md` explains where state lives (memory vs. disk) and the eight steps of one call;
`docs/DSH-API.md` lists every host interface the plugin depends on, which is what to read when an upgrade
makes something stop firing. Design notes and rejected alternatives go to `design/` — the folder is
published, so keep machine-specific paths out of it (`D:\work\...`, `%USERPROFILE%\...` placeholders
instead).
