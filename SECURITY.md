# Security policy

This plugin is a roadblock in front of tool calls, **not a sandbox**. Read
`dsh-guardrails/docs/DSH-API.md` ("What the host does not let a plugin do") and the Limits section of
`README.md` before reporting something that happens outside that boundary — it may be a documented
limitation rather than a vulnerability.

## Supported versions

| Version | Supported |
|---|---|
| latest `1.x` minor | yes — fixes land here |
| older `1.x` minors | security fixes only, when the fix is small enough to back-port |
| below `1.0` | no |

The plugin is Windows-only. Judgement depends on Windows path and shell semantics; behaviour on other
platforms is out of scope, not a bug to fix.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting: **Security → Report a vulnerability** on
the repository. While the repository is still private (it is being prepared for public release), use the
same Security tab if it is available, otherwise contact the maintainer through the GitHub account that
owns the repository. A public issue with step-by-step bypass details helps everyone except the people
running the gate.

A useful report contains:

- the plugin version (`version` in `~/.dsh/guardrails/loaded.json`) and the DSH version;
- the policy file, with your personal paths replaced by placeholders;
- the exact tool call and its arguments — **redact secrets**;
- the verdict you expected (`ask` / `deny`) and the verdict you got, plus the matching lines from
  `~/.dsh/guardrails/audit/v2/` (the command text is in there, redact it too);
- whether the call actually executed.

Never paste an API key, token or private key into a report. If you already did, revoke and rotate it
first; the maintainer will not treat a leaked key as part of the issue.

## In scope

- A call that should have been asked about or denied, but ran silently.
- A bypass of the R1 (DSH home / the plugin's own source), R2 (destructive and critical), R3 (secrets) or
  `entries` band, through a tool call.
- A fail-open path that is not the documented one, or a documented fail-open path with a wider reach than
  the docs claim.
- A policy file that validates but silently weakens the gate (for example a key that is accepted and then
  ignored).
- A break in the audit chain, or a secret written in clear text to a record or payload.

## Out of scope

- Anything outside the tool boundary: a terminal, an editor, a `node` process, pasted text.
- Obfuscation that `README.md` already lists as a known gap (`test/fixtures/contract-cases.json` marks
  those cases with `knownGap` and asserts they currently pass).
- Running the plugin on macOS or Linux.
- Denial of service through a very large call: the gate is allowed to be slow rather than wrong, and it
  fails open when it is.
- Social engineering the user into approving a card. The card exists to make that a human decision.

## What to expect

Acknowledgement on a best-effort basis (aim: 7 days), then an assessment and a fix in the next `1.x`
release with a `CHANGELOG` entry. There is no bounty. Coordinated disclosure of 90 days by default, or
sooner once a fix ships. Credit in the release notes if you want it.
