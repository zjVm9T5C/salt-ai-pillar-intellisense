# Public-release notes — Salt AI Pillar IntelliSense 0.3.2

This file is the operator's guide for the portable 0.3.2 build. The extension
itself is dependency-free: it uses only Node built-ins and the two JSON files
bundled under `schemas/`. Nothing in the VSIX downloads a package, a language
server, or an AI model at install or run time.

## 1. What works without anything else

Immediately after installing the VSIX, these features work offline:

- Salt pillar schema key/value completions for YAML, SLS and Jinja documents.
- Keyword, built-in-function and snippet completions for the languages in
  `schemas/language-completions.json`.
- Cancellation, debounce, bounded event logging and a fail-closed bridge
  client.
- Schema hover explanations, completion-source badges and a status bar that
  names the active source.
- An explicit `Create Local Bridge Token` command that writes `0600` only after
  confirmation and never reveals the secret, plus an `Open Bridge Setup Guide`
  command that opens the bundled `BRIDGE-README.md`.

No Python, Ollama, model, network service, or language server is required for
those features. This is intentionally *keyword/API/snippet* IntelliSense, not
LSP semantic analysis; go-to-definition and type checking are a later phase.

## 2. What the optional bridge adds

The companion `ai_bridge.py` is distributed separately as
`salt-ai-pillar-bridge-0.3.2.tar.gz`. It provides:

- `POST /validate` — PyYAML plus schema diagnostics for YAML-like documents.
- `POST /analyze` — deterministic static-analysis rules for **all** file
  types; YAML-like paths also get schema checks.
- `GET /health` — bridge version and whether the optional model backend is
  reachable.
- `POST /complete` — schema/language context plus an optional model fragment.

The bridge is also local-only. It binds `127.0.0.1:8000` and requires the
shared header `X-Salt-AI-Token`. The extension refuses to send document text
unless it can read the same 0600 token file.

**A model is not required for validation or scanning.** `/validate` and
`/analyze` use the bundled schema and the local rule engine. They make no
model call.

## 3. Model requirement — read carefully

The model is an **optional runtime dependency** for exactly two things:

1. `saltAiPillar.useAI` completions (default **false**).
2. A `Qwen reachable` line in `GET /health`.

If no model is installed, leave `useAI` off. All other features continue to
work, and `/health` simply reports that the model backend is not reachable.

### Default model and provenance

| Item | Value |
| --- | --- |
| Ollama model tag | `hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M` |
| Upstream model | `Qwen/Qwen2.5-0.5B-Instruct` |
| GGUF repository | `Qwen/Qwen2.5-0.5B-Instruct-GGUF` |
| Quantisation | `Q4_K_M` |
| Upstream licence | Apache License 2.0 |
| Licence reference | <https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/main/LICENSE> |
| Ollama endpoint | `http://127.0.0.1:11434` (loopback only) |

The extension does not pin, fetch, or bundle model weights. The tag above is
only the bridge's default; you may install or omit it yourself.

### Explicit setup (nothing is automatic)

Install Ollama for your platform first, keep it bound to loopback, then run the
pull yourself:

```bash
ollama pull hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M
```

To use a different model, pass it to the bridge at startup; the extension does
not need to know the model name:

```bash
python3 ai_bridge.py --model 'hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M' \
  --ollama-url http://127.0.0.1:11434 \
  --schema /path/to/salt-pillar.schema.json \
  --token-file /path/to/bridge-token \
  --log /path/to/ai-bridge.log
```

Never point `--ollama-url` at a remote host and never publish port `11434`. A
public loopback bridge or Ollama listener requires a separate security design
and is explicitly out of scope for this release.

## 4. Token and path settings

Generate one shared secret and give both sides the same path:

```bash
openssl rand -hex 32 > ~/.salt-ai-pillar/bridge-token
chmod 0600 ~/.salt-ai-pillar/bridge-token
```

Then set `saltAiPillar.tokenPath` to that file and start the bridge with
`--token-file` pointing to the same file. Do not commit it, do not put it in a
workspace folder, and do not include it in backups.

Runtime path settings (all machine-scoped; a workspace cannot override them):

| Setting | Default | Purpose |
| --- | --- | --- |
| `saltAiPillar.tokenPath` | `~/ai-notes/bridge-token` | 0600 shared secret read by the extension |
| `saltAiPillar.eventLogPath` | `~/ai-notes/vscode-extension-events.log` | Bounded local event log |
| `saltAiPillar.healthResultPath` | `~/ai-notes/vscode-health-result.json` | Last `/health` JSON result |
| `saltAiPillar.endpoint` | `http://127.0.0.1:8000` | Loopback HTTP bridge base URL |

A leading `~/` expands to the current user's home directory. Absolute paths
are used unchanged. Other settings (`enabled`, `languageCompletions`, `useAI`,
`debounceMs`, `timeoutMs`, `maxTokens`) are described in `README.md`.

## 5. Building the VSIX

```bash
cd /path/to/vscode-ai-pillar
./build-release.sh
sha256sum -c local.salt-ai-pillar-intellisense-0.3.2.vsix.sha256
```

The script stages only `extension.js`, `package.json`, the two schema JSON
files, `README.md`, `LICENSE`, `CHANGELOG.md` and this file. It never stages
`ai-notes/`, token files, logs, or local state.

For a marketplace namespace instead of the local test publisher:

```bash
PUBLISHER=your-publisher VSIX_NAME=your-publisher.salt-ai-pillar-intellisense-0.3.2.vsix ./build-release.sh
```

The `local` publisher is a local identifier, not a marketplace account.
Publishing still needs a verified publisher namespace, a personal access
token, a repository URL, bug tracker URL, homepage and an icon. None of those
are embedded in this build.

### Companion bridge bundle

Build the separate server-side kit with:

```bash
./build-bridge-release.sh
sha256sum -c salt-ai-pillar-bridge-0.3.2.tar.gz.sha256
```

The bundle contains a sanitised `ai_bridge.py`, the shared scanner engine
`ask-ollama-pillars.py`, the Salt schema, MIT licence and
`BRIDGE-README.md`. Development-host paths are rewritten to portable defaults.
It never includes a token, log, model weight, or local note. Users generate
their own 0600 token after extracting; the extension's default
`tokenPath` matches the bridge default.

## 6. Security properties retained

- Endpoint, `useAI`, and all runtime path settings are machine-scoped.
- Only plain HTTP on loopback is accepted; invalid endpoints fall back to the
  default instead of sending document text elsewhere.
- Token absence, blank content, or a length below 32 characters fails closed.
- Requests are debounced, cancellable, and content-hashed in the cache.
- Output-channel and other non-file documents never trigger diagnostics.
- Bridge and Ollama stay on loopback; the shared secret is the only bridge
  authentication mechanism in this release.

## 7. Known limitations

- No LSP servers are bundled or auto-installed; completion is keyword/API/
  snippet based.
- The live development bridge still uses its original host-specific defaults;
  the public bridge tarball is the portable, sanitised copy intended for other
  users. Do not replace the live service with the tarball without a migration
  plan.
- Model output is smoke-test quality. Trust the deterministic schema and scan
  diagnostics over model prose.
- No raw loopback bridge or Ollama port is exposed publicly.
