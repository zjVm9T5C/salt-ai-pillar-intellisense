# Salt AI Pillar bridge kit 0.3.2

This tarball contains the optional local server side of Salt AI Pillar
IntelliSense. It is distributed separately from the VSIX because the extension
itself is dependency-free and must remain safe to install without any Python
service.

## Contents

```text
ai_bridge.py                 loopback HTTP bridge
ask-ollama-pillars.py        shared deterministic scanner rule engine
schemas/salt-pillar.schema.json
BRIDGE-README.md             this file
LICENSE                      MIT
```

No token, log, model weight, or local state is included. You generate the
secret yourself after extracting.

## Requirements

- Python 3.
- PyYAML is recommended for YAML validation. Without it, validation degrades
  to syntax-only checks; scanning still works.
- Optional: Ollama listening only on `127.0.0.1:11434` and a model pulled by
  you. No model is needed for schema completions, validation, or scanning.

## Quick start

```bash
tar xzf salt-ai-pillar-bridge-0.3.2.tar.gz
cd salt-ai-pillar-bridge-0.3.2

mkdir -p ~/ai-notes
openssl rand -hex 32 > ~/ai-notes/bridge-token
chmod 0600 ~/ai-notes/bridge-token

If you installed the 0.3.2 VSIX, you may instead run the command
`Salt AI: AI Pillar: Create Local Bridge Token`. It generates the same 64-character
secret with mode `0600`, asks for confirmation first, and never prints the value.

python3 ai_bridge.py \
  --schema schemas/salt-pillar.schema.json \
  --token-file ~/ai-notes/bridge-token \
  --log ~/ai-notes/ai-bridge.log
```

The bridge binds `127.0.0.1:8000` by default. The extension's default
`saltAiPillar.tokenPath` is `~/ai-notes/bridge-token`, so the two sides match
with no extra settings on a normal setup.

Check it from another terminal:

```bash
TOKEN=$(cat ~/ai-notes/bridge-token)
curl -s -H "X-Salt-AI-Token: $TOKEN" http://127.0.0.1:8000/health
```

Do not print the token in logs or documentation.

## Optional model

Nothing downloads a model automatically. If you want `useAI` completions or a
`Qwen reachable` health line, install Ollama yourself, keep it on loopback,
then run:

```bash
ollama pull hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M
```

Model provenance: `Qwen/Qwen2.5-0.5B-Instruct-GGUF`, Apache License 2.0.
See <https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/main/LICENSE>.

To use another model, pass `--model NAME` to the bridge. Never point
`--ollama-url` at a remote host and never publish port `11434`.

## Portable defaults in this kit

The host-specific paths from the development machine were replaced:

| Setting | Portable default |
| --- | --- |
| Schema | `schemas/salt-pillar.schema.json` beside `ai_bridge.py` |
| Scanner engine | `ask-ollama-pillars.py` beside `ai_bridge.py` |
| Token | `~/ai-notes/bridge-token` |
| Log | `~/ai-notes/ai-bridge.log` |
| Scanner reports | `~/ai-notes` |
| Project workspace for create/fix/run | `~/projects` |

All of these except the scanner location can still be overridden on the
command line (`--schema`, `--token-file`, `--log`, `--ollama-url`, `--model`).

## Security properties

- Bridge binds loopback only.
- Every non-health request requires `X-Salt-AI-Token`.
- The token must be at least 32 characters and should be 0600.
- `/analyze` uses local deterministic rules and calls no model.
- `/validate` is limited to YAML-like path hints.
- The bundle contains no shared secret.

## Verify the download

```bash
sha256sum -c salt-ai-pillar-bridge-0.3.2.tar.gz.sha256
```

See the VSIX's `PUBLIC-RELEASE.md` for the extension-side settings and
marketplace notes.
