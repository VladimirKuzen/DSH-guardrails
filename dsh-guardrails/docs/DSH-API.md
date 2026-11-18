# The DSH surface this plugin stands on

Everything below is what the plugin assumes about the host. None of it is a
sandbox: if the host changes a name or a shape, the gate can degrade **silently**
— it keeps returning `next()` and looks healthy. This page exists so that an
upgrade can be checked in five minutes instead of discovered in an incident.

Tested against DSH as installed on 2026-11-17 (`engines.dsh: >=0.2.0-0`).

## What is used, and what breaks if it moves

| Surface | Used in | The assumption | Visible symptom if it changes |
|---|---|---|---|
| `ctx.on('tools/pre-execute', (exec, next) => …)` | `index.js` | The listener runs before the tool body; returning `next()` allows, a `{ kind }` object decides | **The gate stops gating.** No error, no audit, no card — the plugin still "loads" |
| `next()` | `index.js` | Calling it continues the chain and returns the tool result | Everything is denied or the tool chain breaks |
| `{ kind: 'deny', reason, info }` | `index.js` | The host refuses the call and hands `reason` to the model | Model gets no explanation; the call may still run |
| `{ kind: 'ask', reason, displayReason }` | `index.js` | The host shows the approval card; `displayReason` is the only text we control | Card falls back to the raw tool call, which cannot describe a long command |
| `info.name`, `info.code` | `index.js` | Shown/labelled by the host; `code` is our rule id | Cosmetic, but audit readers key on `info.code` |
| `ctx.on('tools/post-execute', (exec, result, next) => …)` | `index.js` | Fires after the body, `result.isError` reports failure | `executed` records become wrong; approvals may look like runs |
| `ctx.on('session/event', (session, event) => …)` | `index.js` | Delivers `approval/asked` (`data.callId`, `data.id`) and `approval/decided` (`data.id`, `data.outcome`) | `delivered`/`outcome` never arrive: no approval rate, pending entries expire |
| `data.outcome` values | `index.js` | `allowed-once` \| `rejected` \| `cancelled` \| `unavailable` | `executed` is only written for `allowed-once`; a renamed value means **no `executed` records at all** |
| `exec.name`, `exec.arguments` | `rules.js`, `lib/facts.js` | Tool name plus its raw arguments object | Rules match nothing (fail-open) |
| `exec.callId` | `index.js` | Stable per call, shared by all its records | Audit cannot be joined; pending map leaks |
| `exec.agent.session.header.cwd` | `index.js` | The session workspace lives in the session header | `cwdUnder` entries silently never match (mitigated: one `config-invalid` record, see below) |
| `ctx.logger.info/warn/error` | `index.js` | Optional; the plugin uses `?.` everywhere | Warnings vanish; the gate keeps working |
| Profile link + bundle patch | `package.json`, `cordis.patch.yml` | `@vladimirkuzen/dsh-guardrails: link:<repo>/dsh-guardrails` in the profile, listed in `dsh.profile.bundles` | Plugin never mounts; `loaded.json` goes stale (freshness is the signal) |
| `engines.dsh` | `package.json` | Not enforced by the host today; documents the tested range | No effect — this is a note, not a check |

## What the plugin checks by itself

`apply()` probes the one thing a plugin can see from inside: whether `ctx.on`
exists. A context without it can never fire, so the mount writes
`surface: "degraded"` plus `surfaceProblems: ["ctx.on"]` into
`~/.dsh/guardrails/loaded.json`, logs one `logger.error`, and returns instead of
pretending to be mounted. A normal mount writes `surface: "ok"`.

Hook **names**, decision shapes and session fields cannot be probed — there is no
registry to ask. That is exactly why the table above exists.

## After a host upgrade

1. Restart the host, then read `~/.dsh/guardrails/loaded.json`: `version` must
   match `dsh-guardrails/package.json` and `surface` must be `"ok"`.
2. Make one call that must ask (e.g. delete a file outside the workspace) and
   confirm a card appears with our text in the body.
3. Make one call that must deny (write into `~/.dsh`) and confirm the model gets
   the `Guardrails R1: …` reason, with no card.
4. `node dsh-guardrails/tools/audit-report.mjs --verify` — the chain must still
   verify, and the record must carry `requested → delivered → outcome →
   executed`.
5. If any step is silent, compare the table above before trusting the gate: a
   rename shows up here as "the plugin loads but never decides".

## What the host does not let a plugin do

These are limits, not bugs; they shape the design.

- **The approval request carries no structured body.** It deliberately omits the
  tool arguments and points at the already-streamed call by `callId`. So the
  card's command area is the host's rendering of the call, and a plugin cannot
  add an expandable view. `lib/describe.js` compresses into the title line
  instead; the two-stage dry run exists because of this.
- **No client-side UI component.** A plugin can open its own panel, not replace
  the approval card.
- **A plugin cannot see calls made outside the host** (a terminal, an editor, a
  `.ps1` run by hand). The gate covers the tool boundary only.
- **Plugins are evaluated in-process and never hot-reload.** Only `policy.json`
  is picked up live (2-second throttle).
