#!/usr/bin/env bash
# build-release.sh — stage and package the public Salt AI Pillar VSIX.
#
# This script deliberately copies an explicit allow-list of files. It never
# reads ~/ai-notes, token files, logs, or local state, so a release artifact
# cannot accidentally include a shared secret.
#
# Optional environment overrides:
#   PUBLISHER   marketplace/local namespace in the manifest (default: local)
#   VSIX_NAME   output filename (default: <publisher>.salt-ai-pillar-intellisense-<version>.vsix)
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SRC_DIR/build"
STAGE="$BUILD_DIR/extension"

VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SRC_DIR/package.json")"
PUBLISHER="${PUBLISHER:-local}"
VSIX_NAME="${VSIX_NAME:-${PUBLISHER}.salt-ai-pillar-intellisense-${VERSION}.vsix}"
OUT="$SRC_DIR/$VSIX_NAME"

for required in extension.js package.json README.md LICENSE CHANGELOG.md PUBLIC-RELEASE.md public-bridge/BRIDGE-README.md schemas/salt-pillar.schema.json schemas/language-completions.json; do
    [ -f "$SRC_DIR/$required" ] || { echo "missing required file: $required" >&2; exit 1; }
done

rm -rf "$STAGE"
mkdir -p "$STAGE/schemas"

cp "$SRC_DIR/extension.js" \
   "$SRC_DIR/package.json" \
   "$SRC_DIR/README.md" \
   "$SRC_DIR/LICENSE" \
   "$SRC_DIR/CHANGELOG.md" \
   "$SRC_DIR/PUBLIC-RELEASE.md" \
   "$STAGE/"
cp "$SRC_DIR/public-bridge/BRIDGE-README.md" "$STAGE/BRIDGE-README.md"
cp "$SRC_DIR/schemas/salt-pillar.schema.json" \
   "$SRC_DIR/schemas/language-completions.json" \
   "$STAGE/schemas/"
find "$STAGE" -type f -exec chmod 0644 {} +

cat > "$BUILD_DIR/[Content_Types].xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="xml" ContentType="text/xml" />
  <Override PartName="/extension.vsixmanifest" ContentType="application/xml" />
</Types>
XML

cat > "$BUILD_DIR/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="salt-ai-pillar-intellisense" Version="${VERSION}" Publisher="${PUBLISHER}" />
    <DisplayName>Salt AI Pillar IntelliSense</DisplayName>
    <Description xml:space="preserve">Offline multi-language IntelliSense for common source files, with SaltStack pillar schema completions, local static analysis and optional local-model completions.</Description>
    <Tags>saltstack, salt, pillar, yaml, php, cpp, python, javascript, go, rust, ollama, qwen, ai</Tags>
    <Categories>Programming Languages,Linters</Categories>
    <GalleryBannerTheme>dark</GalleryBannerTheme>
    <License>LICENSE</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
XML

chmod 0644 "$BUILD_DIR/[Content_Types].xml" "$BUILD_DIR/extension.vsixmanifest"
rm -f "$OUT" "$OUT.sha256"
(
    cd "$BUILD_DIR"
    zip -q -r -X "$OUT" '[Content_Types].xml' extension.vsixmanifest extension
)
(
    cd "$SRC_DIR"
    sha256sum "$VSIX_NAME" > "$VSIX_NAME.sha256"
)

echo "built: $OUT"
echo "sha256: $(cat "$OUT.sha256" | awk '{print $1}')"
echo "verify: sha256sum -c $(basename "$OUT.sha256")"
