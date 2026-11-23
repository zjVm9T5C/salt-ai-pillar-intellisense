#!/usr/bin/env bash
# build-bridge-release.sh — package a sanitised, portable companion bridge kit.
#
# This script copies the live local bridge/scanner sources, rewrites only the
# development-host paths, and stages an explicit allow-list. It never copies a
# token, log, model weight, or private note.
set -euo pipefail

PROJECT=/home/marootiyiy/vscode-ai-pillar
BRIDGE_SRC=/home/marootiyiy/ai-notes/ai_bridge.py
SCANNER_SRC=/home/marootiyiy/ai-notes/ask-ollama-pillars.py
VERSION="$(python3 -c 'import json; print(json.load(open("/home/marootiyiy/vscode-ai-pillar/package.json"))["version"])')"
NAME="salt-ai-pillar-bridge-${VERSION}"
BUILD="$PROJECT/build/bridge-release"
STAGE="$BUILD/$NAME"
OUT="$PROJECT/${NAME}.tar.gz"

for required in "$BRIDGE_SRC" "$SCANNER_SRC" "$PROJECT/LICENSE" \
                "$PROJECT/public-bridge/BRIDGE-README.md" \
                "$PROJECT/schemas/salt-pillar.schema.json"; do
    [ -f "$required" ] || { echo "missing required file: $required" >&2; exit 1; }
done

rm -rf "$BUILD"
mkdir -p "$STAGE/schemas"

cp "$BRIDGE_SRC" "$STAGE/ai_bridge.py"
cp "$SCANNER_SRC" "$STAGE/ask-ollama-pillars.py"
cp "$PROJECT/LICENSE" "$STAGE/LICENSE"
cp "$PROJECT/public-bridge/BRIDGE-README.md" "$STAGE/BRIDGE-README.md"
cp "$PROJECT/schemas/salt-pillar.schema.json" "$STAGE/schemas/salt-pillar.schema.json"

python3 - "$STAGE/ai_bridge.py" "$STAGE/ask-ollama-pillars.py" <<'PY'
from pathlib import Path
import sys

bridge_path = Path(sys.argv[1])
scanner_path = Path(sys.argv[2])

def replace_exact(text, old, new, label):
    if old not in text:
        raise SystemExit(f"public bridge patch failed: {label} not found")
    return text.replace(old, new)

bridge = bridge_path.read_text(encoding="utf-8")
bridge = replace_exact(
    bridge,
    "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n",
    "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n\n"
    "HERE = pathlib.Path(__file__).resolve().parent\n",
    "bridge HERE constant",
)
bridge = replace_exact(
    bridge,
    'DEFAULT_SCHEMA = "/home/marootiyiy/vscode-ai-pillar/schemas/salt-pillar.schema.json"',
    'DEFAULT_SCHEMA = str(HERE / "schemas" / "salt-pillar.schema.json")',
    "bridge schema path",
)
bridge = replace_exact(
    bridge,
    'DEFAULT_LOG = "/home/marootiyiy/ai-notes/ai-bridge.log"',
    'DEFAULT_LOG = str(pathlib.Path.home() / "ai-notes" / "ai-bridge.log")',
    "bridge log path",
)
bridge = replace_exact(
    bridge,
    'SCANNER_PATH = "/home/marootiyiy/ai-notes/ask-ollama-pillars.py"',
    'SCANNER_PATH = str(HERE / "ask-ollama-pillars.py")',
    "bridge scanner path",
)
bridge = replace_exact(
    bridge,
    'DEFAULT_TOKEN_FILE = "/home/marootiyiy/ai-notes/bridge-token"',
    'DEFAULT_TOKEN_FILE = str(pathlib.Path.home() / "ai-notes" / "bridge-token")',
    "bridge token path",
)
bridge_path.write_text(bridge, encoding="utf-8")

scanner = scanner_path.read_text(encoding="utf-8")
scanner = replace_exact(
    scanner,
    'DEFAULT_OUT_DIR = pathlib.Path("/home/marootiyiy/ai-notes")',
    'DEFAULT_OUT_DIR = pathlib.Path.home() / "ai-notes"',
    "scanner output dir",
)
scanner = replace_exact(
    scanner,
    'PROJECTS_ROOT = pathlib.Path("/home/marootiyiy/projects")',
    'PROJECTS_ROOT = pathlib.Path.home() / "projects"',
    "scanner projects root",
)
scanner = scanner.replace("/home/marootiyiy/ai-notes", "~/ai-notes")
scanner = scanner.replace("/home/marootiyiy/projects", "~/projects")
scanner_path.write_text(scanner, encoding="utf-8")
PY

if grep -RIn '/home/marootiyiy' "$STAGE"; then
    echo "refusing to package: development-host path remains" >&2
    exit 1
fi
if [ -e "$STAGE/bridge-token" ] || [ -e "$STAGE/ai-bridge.log" ]; then
    echo "refusing to package: token or log staged" >&2
    exit 1
fi

find "$STAGE" -type f -name '*.py' -exec chmod 0755 {} +
find "$STAGE" -type f ! -name '*.py' -exec chmod 0644 {} +
find "$STAGE" -type d -exec chmod 0755 {} +

rm -f "$OUT" "$OUT.sha256"
tar -C "$BUILD" -czf "$OUT" "$NAME"
(
    cd "$PROJECT"
    sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256"
)

echo "built: $OUT"
echo "sha256: $(awk '{print $1}' "$OUT.sha256")"
echo "verify: sha256sum -c $(basename "$OUT.sha256")"
