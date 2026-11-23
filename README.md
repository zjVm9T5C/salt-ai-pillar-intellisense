# Salt AI Pillar IntelliSense (portable, dependency-free)

VS Code extension that provides:

- **Path A — Salt schema:** instant key/value completions and validation for
  YAML/SLS/Jinja from the bundled `schemas/salt-pillar.schema.json`. These items
  keep the highest priority for those file types.
- **Path A2 — offline languages:** keyword, built-in-function and snippet
  completions for the languages in `schemas/language-completions.json`: PHP,
  C/C++, Python, JavaScript/TypeScript, Go, Rust, Shell, Java, C#, SQL,
  JSON/YAML, Terraform, Dockerfile, Ruby, Lua, PowerShell, HTML, CSS and
  Markdown. No language server or network call is required.
- **Path B — optional loopback bridge:** a companion `ai_bridge.py` exposes
  `/complete`, `/validate`, `/analyze`, `/health` and `/config` on
  `127.0.0.1:8000`. It runs deterministic local rules for all languages and
  applies PyYAML/schema validation only to YAML-like paths.
- **Vulnerability scan:** `/analyze` reuses the same local rule engine as the
  CLI scanner. Findings are deterministic and call no model.
- **Trust features:** hover over a Salt pillar key to read its schema
  description, see a source badge on every completion (`schema`,
  `offline dataset`, `local rules`, `AI model`), and watch the status bar report
  the active source. Token creation is an explicit command, never an install
  side effect.

The extension uses only Node built-ins; no `npm install` is needed. The bridge
uses the Python standard library plus optional PyYAML.

> Examples below show the original development host paths. Replace them with
> your own paths. A leading `~/` in an extension setting expands to your home
> directory.

## Requirements

| Feature | Requirements |
| --- | --- |
| Offline completions, Salt schema completions | VS Code 1.90+ only |
| Validate / scan commands | Companion loopback bridge from `salt-ai-pillar-bridge-0.3.2.tar.gz`, Python 3, PyYAML recommended, 0600 shared token file |
| Optional AI completions (`useAI`) | All of the above, plus a local Ollama listener and an explicitly pulled model |

**No model is required** for offline IntelliSense, Salt schema completions,
validation, or scanning. See [Model requirements](#model-requirements).

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `saltAiPillar.tokenPath` | `~/ai-notes/bridge-token` | 0600 shared secret read by the extension; machine-scoped; created only by the explicit token command or by you |
| `saltAiPillar.eventLogPath` | `~/ai-notes/vscode-extension-events.log` | Bounded local event log; machine-scoped |
| `saltAiPillar.healthResultPath` | `~/ai-notes/vscode-health-result.json` | Last `/health` JSON result; machine-scoped |
| `saltAiPillar.endpoint` | `http://127.0.0.1:8000` | Bridge API base URL, loopback HTTP only; machine-scoped |
| `saltAiPillar.enabled` | `true` | Enable completions |
| `saltAiPillar.languageCompletions` | `true` | Offer offline completions for supported source languages |
| `saltAiPillar.useAI` | `false` | Ask the optional local model too; off by default |
| `saltAiPillar.debounceMs` | `300` | Minimum ms between bridge calls per document |
| `saltAiPillar.timeoutMs` | `3000` | HTTP timeout; raise when `useAI` is on |
| `saltAiPillar.maxTokens` | `24` | Maximum tokens for the optional AI fragment |

Invalid, credential-bearing, or non-loopback endpoints fall back to the
default. If the token file is missing, blank, or shorter than 32 characters,
the extension refuses to send document text but still offers local completions.

## Commands

- **Salt AI: Validate YAML** — PyYAML + schema diagnostics for YAML/SLS/Jinja.
  Other file types are told to use Scan instead.
- **Salt AI: Scan for Vulnerabilities** — deterministic local static rules for
  the detected language (secrets, TLS disabled, privileged containers,
  Shell/PHP/Python/JS/C/C++ issues, and so on), plus schema checks for YAML.
  No model call.
- **Salt AI: Check Bridge Health** — bridge version and whether the optional
  model backend is reachable. Writes JSON to `healthResultPath`.
- **Salt AI: Enable/Disable Completion** — toggles completions.
- **Salt AI: Create Local Bridge Token** — after a modal confirmation, generates
  a 64-character secret at `tokenPath` with mode `0600`. It never prints or logs
  the token, and it does not restart the bridge.
- **Salt AI: Open Bridge Setup Guide** — opens the bundled `BRIDGE-README.md`
  from the companion tarball.

Completions trigger on `:`, `-`, `.`, `<` and `#`. Each completion's detail line
names its source. YAML/SLS/Jinja receive Salt
schema items first; other supported files receive offline language items
immediately. A model item is appended only when `useAI` is enabled.

## Model requirements

The model is an **optional runtime dependency** for `useAI` completions and for
`/health` to report `Qwen reachable`. It is not needed for core offline
IntelliSense, Salt schema validation, or scanning. The extension never
downloads a model or starts Ollama by itself.

Default bridge model:

```text
hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M
```

This is the Ollama tag for the GGUF quantisation of
`Qwen/Qwen2.5-0.5B-Instruct`, upstream licence Apache License 2.0. See
<https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/main/LICENSE>.
Override it with the bridge's `--model` flag if you prefer another model.

Install Ollama for your platform, keep it bound to loopback, and pull the model
explicitly:

```bash
ollama pull hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M
```

Do not expose `127.0.0.1:11434` or the bridge port publicly. A public listener
would require a separate security design.

## Start the bridge (optional)

Users should download and extract `salt-ai-pillar-bridge-0.3.2.tar.gz`. It
contains sanitised, portable copies of `ai_bridge.py`, the scanner engine and
the schema. The variables below are just shell conveniences; they are not
created by the VSIX.

```bash
TOKEN_PATH="$HOME/ai-notes/bridge-token"
SCHEMA="$HOME/vscode-ai-pillar/schemas/salt-pillar.schema.json"
BRIDGE="$HOME/ai-notes/ai_bridge.py"

openssl rand -hex 32 > "$TOKEN_PATH"
chmod 0600 "$TOKEN_PATH"

python3 "$BRIDGE" \
  --model hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M \
  --ollama-url http://127.0.0.1:11434 \
  --schema "$SCHEMA" \
  --token-file "$TOKEN_PATH" \
  --log "$HOME/ai-notes/ai-bridge.log"

# In another terminal:
TOKEN=$(cat "$TOKEN_PATH")
curl -s -H "X-Salt-AI-Token: $TOKEN" http://127.0.0.1:8000/health
```

Keep the token file out of version control and backups. The bridge binds only
loopback, and the token is intentionally excluded by the local backup scripts.

## Install / uninstall

```bash
# Set CODE to your VS Code server CLI, then:
$CODE ext install ./local.salt-ai-pillar-intellisense-0.3.2.vsix
$CODE ext list
$CODE ext uninstall local.salt-ai-pillar-intellisense
```

Reload the VS Code window after installing or upgrading. The previous 0.3.0
build can be kept for rollback.

## Public release

See `PUBLIC-RELEASE.md` for packaging, publisher overrides, model provenance,
security properties and marketplace prerequisites. Build a fresh VSIX with:

```bash
./build-release.sh
sha256sum -c local.salt-ai-pillar-intellisense-0.3.2.vsix.sha256

./build-bridge-release.sh
sha256sum -c salt-ai-pillar-bridge-0.3.2.tar.gz.sha256
```

## Hardening history

- **0.2.1:** machine-scoped `endpoint`/`useAI`, runtime endpoint validation,
  offline schema completions, timeout alignment, cancellable requests, bounded
  serialised event log.
- **0.2.2:** shared-secret `X-Salt-AI-Token`, fail-closed token handling,
  HTTP-only loopback endpoint, true debounce with single-flight cancellation,
  content-hashed cache keys, listener cleanup, automatic post-edit diagnostics.
- **0.3.0:** all-file completion provider, offline multi-language dataset,
  Salt schema priority, deterministic all-file `/analyze`, YAML-only
  `/validate`, Output-channel feedback guard.
- **0.3.1:** portable path settings, MIT licence, public-release documentation,
  explicit model requirements, reproducible VSIX build and a sanitised companion
  bridge bundle.
- **0.3.2:** schema hover explanations, completion-source badges, source-aware
  status bar, explicit 0600 token creation and a bundled setup-guide command.
  No install-time secret creation and no automatic model download.
