# dsh-guardrails

Deterministic guardrails for **DeepSeek Harness** (DSH): the plugin sits on `tools/pre-execute` and asks or
denies a tool call before it runs — writing to DSH's own home, destructive shell commands, secrets in
arguments — and records one JSONL line per intercepted call. Windows only, no runtime dependencies, no
network, no model in the loop.

The full documentation lives in the repository: <https://github.com/VladimirKuzen/DSH-guardrails>

- What a card says and why it was shown: `docs/DETAIL.md`
- Modes, `entries`, and the three-step way to loosen a band: `docs/POLICY.md`
- File map and the eight steps of one call: `docs/ARCHITECTURE.md`
- Host interfaces this depends on, and what breaks when one moves: `docs/DSH-API.md`

Install into a DSH profile:

```powershell
dsh plugin --profile desktop add @vladimirkuzen/dsh-guardrails
```

`dsh plugin` forwards to `pnpm` in the profile directory and enables the bundle; restart DSH afterwards and
check that `~/.dsh/guardrails/loaded.json` reports a matching `version` and `surface: "ok"`. Installing from a
checkout, configuring a policy, reading the audit trail and uninstalling are covered in the repository
README: <https://github.com/VladimirKuzen/DSH-guardrails#install>.

Licensed under the MIT license; the text is in [LICENSE](LICENSE).
