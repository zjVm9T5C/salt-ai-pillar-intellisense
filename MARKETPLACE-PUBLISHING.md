# Marketplace publishing runbook — Salt AI Pillar IntelliSense

**Status (2026-11-22): PREPARATION COMPLETE — NOT YET PUBLISHABLE.**

This is an **operator document**. It is deliberately **not** staged into the VSIX
by `build-release.sh`, so the shipped 0.3.2 artifact and its SHA-256 remain
unchanged. Applying any change below requires a new version build, a fresh
verification pass, and refreshed backups.

Sources: <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>
(checked 2026-11-22).

---

## 1. Time-sensitive constraint

> **Global Azure DevOps Personal Access Tokens are retired on 2026-12-01.**

Today is 2026-11-22, so a PAT-based publish has a window of about **nine days**.
Prefer the OIDC / Entra ID paths in §5. If you choose a PAT, create it before
the retirement date and treat it as a short-lived credential, not a permanent
one.

---

## 2. Readiness gate — what is present and what is missing

| Item | State | Severity | Notes |
|---|---|---|---|
| `name`, `version`, `publisher`, `engines.vscode`, `license` | present | — | `publisher` is the placeholder `local` and **must** change |
| `README.md`, `LICENSE`, `CHANGELOG.md` in VSIX | present | — | good |
| `SUPPORT.md` | **missing** | low | recommended by Microsoft for support routing |
| `icon` (PNG ≥ 128×128) | **missing** | medium | recommended for a credible listing; must be PNG, never SVG. Note: the official `vsce` validator did **not** treat this as a hard error or even a warning |
| `.vscodeignore` or `files` property | **missing** | low for us | `vsce` warned about it; our hand-built allow-list already provides the same protection, but add it if you switch to `vsce package` |
| `repository` | **missing** | medium | also lets `vsce` rewrite relative README links |
| `bugs` | **missing** | low | issue tracker URL |
| `homepage` | **missing** | low | project URL |
| `galleryBanner` | **missing** | low | the hand-built VSIX hardcodes a dark theme instead |
| Name / display-name uniqueness | **confirmed free** (2026-11-22) | — | Marketplace gallery API returned 0 matches for both `salt-ai-pillar-intellisense` and `Salt AI Pillar IntelliSense`; control query for `ms-python.python` returned 1, validating the method. Direct item page for `local.salt-ai-pillar-intellisense` returns HTTP 404 |
| Publisher account + identity | **missing** | blocker | ID is immutable once created |
| Credential (OIDC policy or PAT) | **missing** | blocker | see §5 |
| Keyword count | 13 of 30 | — | within the 30-tag limit |
| SVG / insecure image URLs | none | — | passes `vsce` media rules |
| Token / host path in VSIX | none | — | verified clean |

### Manifest inconsistencies found by the audit

The handcrafted `extension.vsixmanifest` does not perfectly mirror
`package.json`:

1. `<Categories>` is `Programming Languages,Linters`; `package.json` also
   declares `Machine Learning`.
2. `<Assets>` does not declare the License or Changelog assets.
3. `<InstallationTarget>` has no `Version` attribute (normally derived from
   `engines.vscode`, e.g. `[1.90.0,)`).
4. The dark banner theme lives only in the VSIX manifest, not in
   `package.json`.

Items 1–4 worked for local installation, but the official `vsce` tool would
generate them differently. The clean fix is to let `vsce package` build the
release VSIX instead of the hand-rolled zip — see §4.

### Name uniqueness check (2026-11-22)

Queried the live Marketplace gallery API for both the extension name
`salt-ai-pillar-intellisense` and the display name `Salt AI Pillar IntelliSense`:
**0 matches for each**. A control query for `ms-python.python` returned exactly
one result, proving the query method works. The direct item page for
`local.salt-ai-pillar-intellisense` returns HTTP 404.

**Conclusion:** the name is available. This is no longer a blocker. Re-check
immediately before publishing, since names can be claimed at any time.

### Official validator result (2026-11-22)

I ran the real validator in an isolated temp directory with its own npm cache;
nothing was installed globally and no host configuration was changed.

```text
vsce package --no-dependencies
  WARNING  A 'repository' field is missing from package.json.
  WARNING  Neither a .vscodeignore file nor a "files" property was found.
  DONE     Packaged 11 files, 32.83 KB
  validate_rc=0
```

**There were no hard errors, and no icon warning.** This means the extension is
already *packageable*; the blockers are marketplace-side — publisher identity,
a credential, and the name-uniqueness check — not manifest defects.

Note that `vsce` normalises filenames in its output: `LICENSE` → `LICENSE.txt`,
`README.md` → `readme.md`, `CHANGELOG.md` → `changelog.md`. That is expected and
does not affect the hand-built 0.3.2 VSIX.

An earlier `npx --yes` attempt failed with `Cannot find module 'cockatiel'`;
that was a partial download in the npm cache, not a finding about this project.
The clean explicit install succeeded. Evidence:
`/tmp/opencode/vsce-package-validation2-2026-11-22.log`.

---

## 3. Exact source changes required

In `/home/marootiyiy/vscode-ai-pillar/package.json`, replace the placeholders
with your real values:

```json
{
  "publisher": "<YOUR_PUBLISHER_ID>",
  "icon": "icon.png",
  "repository": {
    "type": "git",
    "url": "https://github.com/<OWNER>/<REPO>.git"
  },
  "bugs": {
    "url": "https://github.com/<OWNER>/<REPO>/issues"
  },
  "homepage": "https://github.com/<OWNER>/<REPO>#readme",
  "galleryBanner": {
    "color": "#0b1021",
    "theme": "dark"
  }
}
```

Then:

- Add `icon.png` (real PNG, at least 128×128) to the repository root and to the
  allow-list in `build-release.sh` **only if** you keep the hand-built zip path.
- Add `SUPPORT.md` at the repository root describing how to get help.
- Keep `saltAiPillar.useAI` at `false` and keep the bundled model wording:
  the model is an **optional runtime dependency** for AI completions only.
- Re-run the extension harness, `verify-session.sh`, both backups, and the
  archive integrity checks before publishing.

---

## 4. Two build paths

### Preferred — let `vsce` build the VSIX

This removes the manifest inconsistencies in §2 automatically.

```bash
cd /home/marootiyiy/vscode-ai-pillar
# Prefer an explicit local install: a bare `npx --yes` left a partial cache
# during testing (missing 'cockatiel'). This worked reliably:
npm install --no-audit --no-fund @vscode/vsce@latest   # once, in the project
./node_modules/.bin/vsce package --no-dependencies
sha256sum -c <generated>.vsix.sha256   # only if you record one
```

`vsce` reads `package.json`, generates a correct `extension.vsixmanifest`, and
warns about missing icon/metadata before you ever publish.

### Current — hand-built allow-list zip

```bash
cd /home/marootiyiy/vscode-ai-pillar
PUBLISHER=<YOUR_PUBLISHER_ID> ./build-release.sh
sha256sum -c local.salt-ai-pillar-intellisense-<VERSION>.vsix.sha256
```

This preserves the strong guarantee that only an explicit allow-list is
shipped — no token, no logs, no local state. If you use it, fix the four
manifest inconsistencies in §2 by hand.

---

## 5. Authentication and publishing

### 5a. Trusted Publishing with GitHub Actions (recommended, no stored secret)

1. Sign in at <https://marketplace.visualstudio.com/manage>.
2. Open your publisher → **Trusted Publishing** → **Create**.
3. Enter policy name, exact repository owner, repository, workflow filename and
   optional environment.
4. In the workflow, grant `id-token: write` and publish with OIDC:

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx @vscode/vsce publish --oidc
```

The Marketplace credential lasts 15 minutes and each OIDC token is single-use.
For a private repository, run the workflow within 48 hours of creating the
policy or the first exchange will not activate it.

### 5b. Azure Pipelines with Microsoft Entra ID

Create an Azure Resource Manager service connection using Workload Identity
Federation, create a user-assigned managed identity, establish federated
credentials, add the identity's resource ID as a **Contributor** member of your
publisher, then publish with:

```bash
vsce publish --azure-credential
```

Requires `vsce >= 2.26.1`.

### 5c. PAT fallback (only before 2026-12-01, not recommended)

Create the PAT with **All accessible organizations** and the
**Marketplace (Manage)** scope. Then:

```bash
npx --yes @vscode/vsce@latest login <YOUR_PUBLISHER_ID>
npx --yes @vscode/vsce@latest publish
```

A 403/401 almost always means the wrong organization scope or a missing
Marketplace (Manage) permission.

### 5d. Manual upload

`vsce package` then upload the VSIX through the publisher management page. This
needs an interactive Microsoft account session but no CLI credential.

---

## 6. Pre-publish checklist

```bash
# 1. Artifact integrity
cd /home/marootiyiy/vscode-ai-pillar
sha256sum -c local.salt-ai-pillar-intellisense-<VERSION>.vsix.sha256
sha256sum -c salt-ai-pillar-bridge-<VERSION>.tar.gz.sha256

# 2. No secret or local path
TOKEN=$(cat /home/marootiyiy/ai-notes/bridge-token)
unzip -p <VSIX> | grep -Fq "$TOKEN" && echo LEAK || echo clean
unzip -p <VSIX> | grep -Fq '/home/marootiyiy' && echo LEAK || echo clean

# 3. Host still green
/home/marootiyiy/verify-session.sh     # expect 51 passed, 0 failed

# 4. Official validator warnings
npx --yes @vscode/vsce@latest package --no-dependencies   # read every warning

# 5. Name uniqueness
# Check both the extension name AND display name on the Marketplace.
```

---

## 7. After publishing

- Verify the listing shows the correct publisher, icon, README, license and
  support links.
- Confirm the description states the model is an **optional runtime dependency
  for AI completions only**, and that offline IntelliSense, schema completions,
  validation and scanning need no model.
- Install the published extension into a clean VS Code profile and run the
  smoke commands: hover a Salt key, `Ctrl+Space` for source badges, and
  `Open Bridge Setup Guide`.
- Do **not** delete the extension name: removed names are reserved forever. Do
  not delete version numbers either; they cannot be reused, and the latest
  version cannot be deleted at all.

---

## 8. Reminder — what must never change

- `saltAiPillar.useAI` stays `false` by default.
- The loopback bridge stays on `127.0.0.1`; never expose it or Ollama publicly
  without a separate security redesign.
- No runtime download of packages, language servers or models.
- No token, log or `/home/marootiyiy` path in any shipped artifact.
- `BACKUP_REMOTE` must never be a local path.

---

## 9. GitHub repository setup (2026-11-23)

### Toolchain state

- Homebrew **7.0.13** was already installed at `/home/linuxbrew/.linuxbrew`;
  the owner's `.bashrc` already sources `brew shellenv`.
- GitHub CLI `gh` **2.105.0** was installed from a Brew bottle. Evidence:
  `/tmp/opencode/brew-gh-install-2026-11-23b.log` (`brew_install_rc=0`).
- No `/etc` or `/usr` file changed, so no AIDE rebaseline was needed.

### What is prepared locally

- `git init` was run in this directory as `marootiyiy`.
- `.gitignore` excludes `/build/`, `*.vsix`, `*.tar.gz`, `*.sha256`,
  `node_modules/`, `.env`, `bridge-token`, `ai-notes/` and `*.log`.
- `.github/workflows/publish.yml.example` is an **inert** OIDC publishing
  workflow template. The `.example` suffix means GitHub Actions will not run
  it. Rename it to `publish.yml` only after all five conditions in the file
  are met.
- Sixteen source files are **staged but not committed**. The owner chose to
  skip setting a global git identity, so no commit was made and no remote was
  created. No token is in the git index.

### Owner hand-off commands

Run these yourself, in this order, from your own terminal:

```bash
cd ~/vscode-ai-pillar
gh auth login                       # choose GitHub.com → HTTPS → browser/device
# Confirm: gh auth status

# No global git identity was configured, so supply one per commit:
git -c user.name="YOUR_NAME" -c user.email="YOUR_EMAIL" \
    commit -m "Initial import of Salt AI Pillar IntelliSense"

# Private is the safe default while the extension is unreleased.
gh repo create salt-ai-pillar-intellisense --private \
    --source=. --remote=origin --push
```

After the push, create the Marketplace **Trusted Publishing** policy with the
exact owner, repository and workflow filename `publish.yml` (the filename must
match after you rename the template). Note that a **private** repository must
run the workflow within 48 hours of creating the policy for the first OIDC
exchange to activate it.

**Deliberately not done today:** no remote repository, no commit, no
authentication, no manifest publisher change, and no Marketplace publication.
