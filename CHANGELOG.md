# Changelog

All notable changes to the Salt AI Pillar IntelliSense extension are recorded
here. The format follows the spirit of Keep a Changelog: newest first, with
security-relevant changes called out explicitly.

## 0.3.2 — trust and onboarding

- **Schema hover.** Hovering over a Salt pillar key now shows its bundled
  schema description, type, allowed values and default where present. This is
  fully offline and uses the same schema that drives completions.
- **Source transparency.** Every completion detail line now names its origin:
  `schema`, `offline dataset`, `local rules` or `AI model`. The status bar also
  reports the active source instead of only saying `AI`.
- **Explicit token setup.** Added `Salt AI: AI Pillar: Create Local Bridge
  Token`, a modal-confirmed command that writes 64 hex characters with mode
  `0600`. It never prints, logs or messages the secret, and never runs at
  activation.
- **Bundled setup guide.** Added `Salt AI: AI Pillar: Open Bridge Setup Guide`,
  which opens the `BRIDGE-README.md` shipped inside the VSIX. The release script
  now stages that file explicitly.
- **Security properties retained.** Loopback-only HTTP, `X-Salt-AI-Token`
  fail-closed handling, `useAI` default false, no model download, and no
  install-time creation of token, log or bridge variables.

## 0.3.1 — public-release preparation

- **Portable runtime paths.** Replaced hardcoded `/home/marootiyiy/...` paths
  with `os.homedir()` defaults and three machine-scoped settings:
  `saltAiPillar.tokenPath`, `saltAiPillar.eventLogPath`, and
  `saltAiPillar.healthResultPath`. A leading `~/` is expanded at runtime.
- **Fail-closed behaviour preserved.** The bridge token is still required for
  any request that can carry document text; a missing, blank, or too-short
  token disables bridge calls without disabling offline completions.
- **Packaging.** Added `LICENSE` (MIT), this changelog, `PUBLIC-RELEASE.md`,
  `build-release.sh` and `build-bridge-release.sh`. The VSIX stages only the
  extension, schemas and documentation. The companion bridge tarball stages a
  sanitised bridge/scanner pair with portable defaults. Neither artifact
  contains the token, logs, or local notes.
- **Documentation.** `README.md` and `PUBLIC-RELEASE.md` now state clearly that
  the model is an optional runtime dependency for `useAI` completions and
  health reporting only. Offline IntelliSense, Salt schema completions,
  validation, and scanning do not call a model.
- **Publisher handling.** Local builds keep publisher `local`; the release
  script accepts `PUBLISHER` and `VSIX_NAME` overrides for a real marketplace
  namespace. No marketplace credentials or repository URLs are embedded.

## 0.3.0 — multi-language IntelliSense

- Added the bundled `schemas/language-completions.json` dataset for PHP,
  C/C++, Python, JavaScript/TypeScript, Go, Rust, Shell, Java, C#, SQL,
  JSON/YAML, Terraform, Dockerfile, Ruby, Lua, PowerShell, HTML, CSS and
  Markdown.
- Registered one completion provider for every `file:` document. Salt schema
  items keep priority `0` for YAML/SLS/Jinja; offline language items sort next;
  optional model items sort last.
- Auto-diagnostics call `/analyze` for all file types and `/validate` only for
  YAML-like documents. The Output-channel feedback guard was preserved.
- Companion bridge v0.3.0 runs the deterministic local rule engine for every
  detected language and limits PyYAML/schema validation to YAML-like paths.

## 0.2.2 — shared-secret hardening

- Bridge requires `X-Salt-AI-Token` from a 0600 token file.
- Extension refuses to send document text when the token is missing, blank,
  or too short.
- Endpoint validation accepts only plain HTTP on loopback; invalid endpoints
  fall back to the default.
- True debounce with per-document single-flight cancellation, content-hashed
  cache keys, and cancellation-listener cleanup on all paths.
- Automatic re-validation and re-scan 600 ms after edits.

## 0.2.1 — offline-first completions

- Machine-scoped `endpoint` and `useAI` settings.
- Local Salt schema completions work while the bridge is offline.
- `useAI` sends the same effective timeout to the bridge that the client waits
  for.

## 0.1.0–0.2.0 — initial builds

- Local Salt pillar schema completions, YAML validation, vulnerability scan
  command, loopback bridge client, and incremental hardening.
