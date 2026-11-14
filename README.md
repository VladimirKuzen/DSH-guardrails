# dsh-guardrails

**English** | [中文](README.zh-CN.md)

A small, dependency-free guardrail for **DSH** that gates risky tool calls *before* they run,
and leaves a local audit trail of what was gated.

- **Host-native**: a DSH plugin listening on `tools/pre-execute`. No daemon, no proxy, no extra process.
- **Deterministic**: path and pattern rules only. No model calls, no network, no judgment from the same
  model that proposes the action.
- **Auditable**: every gated call writes one JSONL line; secrets are never written in clear text.
- **Windows-only**, pre-1.0. Path semantics assume Windows (`~`, `%VAR%`, `$env:VAR`, backslashes).

## Why

An agent is most dangerous at the boundary between a sentence and an action: it can rewrite its own
configuration, delete a directory it misread, or paste an API key into a log. Prompt-level instructions
do not stop any of that. This gate sits on the last hop before execution and asks a human — or refuses.

## Rules

| Rule | Fires when | Default |
|---|---|---|
| **R1** Protect DSH's own home | Tool writes inside `~/.dsh` or `~/.agents`; a shell command both mentions those directories and carries a write/delete/move verb; any `plugin_manager` operation | ask |
| **R2** Destructive operations | Delete/move/rename in command position, `robocopy /MIR`, `git reset --hard`, `git clean -f`, `format`, `diskpart`, `reg delete`, `sc delete`, `takeown`, `icacls` permission changes | ask |
| **R3** Secrets in tool arguments | Ark / `sk-` / `AKIA` / `ghp_` / `AIza` / `xox` / bearer tokens / private key blocks / `key=...` assignments | deny in shell commands, ask on file writes (label only) |

Every rule can be set to `ask`, `deny` or `off`. Read-only calls and ordinary writes inside the
workspace are not touched.

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
must not brick the tool chain. If the plugin itself never mounts, the host simply runs unguarded —
`loaded.json` exists so that this state is detectable (see below).

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
| Audit | `~/.dsh/guardrails/audit/audit-YYYY-MM-DD.jsonl` (local date) |
| Heartbeat | `~/.dsh/guardrails/loaded.json` |

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

`patterns` appends your own regular expressions to the built-in lists. A corrupt policy file is ignored in
favour of the last good copy — the gate never disappears because of a bad edit.

## Repository layout

| Path | Purpose |
|---|---|
| `dsh-guardrails/` | The plugin: `index.js` (host wiring), `rules.js` (pure decision logic) |
| `dsh-guardrails/test/` | Rule tests and package smoke test |
| `docs/` | Design and implementation plan |
| `scripts/` | Maintainer tooling — audit redaction, snapshot/restore, health check. **Not shipped with the plugin** |

Maintainer tooling exists because audit files contain command text and paths. It snapshots and redacts
them locally, then encrypts the result with Windows DPAPI (bound to the current user account).

## Development

No build step, no runtime dependencies. Tests run directly:

```powershell
node dsh-guardrails/test/rules.test.mjs
node dsh-guardrails/test/plugin.smoke.mjs
```

Run them with `node <file>`, not `node --test`: the DSH sandbox forbids the child processes that runner spawns.

## Limits

- **Not a sandbox.** It sees tool calls only. Text pasted straight into a conversation bypasses it, and a
  user with local access can edit files directly.
- **Rules are regex- and path-based.** Obfuscated shell (variable assembly, `cmd /c`, `powershell -enc`)
  can evade the destructive-command patterns; R1's path check is the stronger of the three.
- **Approval surfaces may not match the plan.** The host renders the decision prompt; the plugin can only
  supply its text.
- **Audit records the match today, not the outcome.** Logging the human decision is on the roadmap.
- Windows only.

## Uninstall

Remove `@vlad/dsh-guardrails` from the profile's `dsh.profile.bundles` and its `dependencies`, then
restart DSH. Existing audit files are left in place; delete them yourself if you want them gone.

## License

MIT.
