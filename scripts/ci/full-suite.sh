#!/usr/bin/env bash
# Runs the full local check: the private identifier scan and gitleaks' default rules (the same
# two scans as the pre-commit hook and the gitleaks workflow, see CONTRIBUTING.md), then
# npm ci, the typecheck, the web build and the full test set against the Firestore emulator.
#
# Run it from the repository root. It needs Node.js 24, git and network access. The pinned
# tools the checks use are taken from PATH when the right version is already installed;
# otherwise they are downloaded once, checked against a pinned SHA-256, and kept in
# ANTWARS_CI_CACHE (default: ${XDG_CACHE_HOME:-$HOME/.cache}/antwars-ci):
#   - gitleaks 8.30.1 (the version and checksum the gitleaks workflow uses);
#   - firebase-tools 15.35.0 (the version CONTRIBUTING.md names);
#   - a Java 21 runtime (Eclipse Temurin), used only when no Java 21 or later is on PATH.
#
# The identifier list stays outside the repository, at <git-common-dir>/antwars-identifiers;
# without it the script refuses to run rather than skip the identifier scan.
set -euo pipefail

cache="${ANTWARS_CI_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/antwars-ci}"
mkdir -p "$cache"

# fetch_verified <url> <sha256> <output file>: download with Node's fetch (no curl needed) and
# keep the file only when its SHA-256 matches.
fetch_verified() {
  local url="$1" sum="$2" out="$3"
  node --input-type=module -e '
    import { createHash } from "node:crypto";
    import { writeFileSync } from "node:fs";
    const [url, sum, out] = process.argv.slice(1);
    const res = await fetch(url);
    if (!res.ok) { console.error(`full-suite: download failed (${res.status}): ${url}`); process.exit(1); }
    const buf = Buffer.from(await res.arrayBuffer());
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== sum) { console.error(`full-suite: checksum mismatch for ${url}`); process.exit(1); }
    writeFileSync(out, buf);
  ' "$url" "$sum" "$out"
}

# gitleaks 8.30.1
gitleaks_version=8.30.1
gitleaks_sha256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
if ! { command -v gitleaks > /dev/null && [ "$(gitleaks version 2> /dev/null)" = "$gitleaks_version" ]; }; then
  dir="$cache/gitleaks-$gitleaks_version"
  if [ ! -x "$dir/gitleaks" ]; then
    mkdir -p "$dir"
    fetch_verified "https://github.com/gitleaks/gitleaks/releases/download/v${gitleaks_version}/gitleaks_${gitleaks_version}_linux_x64.tar.gz" \
      "$gitleaks_sha256" "$dir/gitleaks.tar.gz"
    tar -xzf "$dir/gitleaks.tar.gz" -C "$dir" gitleaks
    rm -f "$dir/gitleaks.tar.gz"
  fi
  PATH="$dir:$PATH"
fi

# firebase-tools 15.35.0
firebase_version=15.35.0
if ! { command -v firebase > /dev/null && [ "$(firebase --version 2> /dev/null)" = "$firebase_version" ]; }; then
  dir="$cache/firebase-tools-$firebase_version"
  if [ ! -x "$dir/node_modules/.bin/firebase" ]; then
    npm install --prefix "$dir" "firebase-tools@$firebase_version" --no-audit --no-fund --loglevel=error
  fi
  PATH="$dir/node_modules/.bin:$PATH"
fi

# Java 21 or later, for the Firestore emulator
java_major() { java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -n 1; }
if ! { command -v java > /dev/null && [ "$(java_major)" -ge 21 ] 2> /dev/null; }; then
  jre_name=jdk-21.0.13+9-jre
  jre_sha256=a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd
  dir="$cache/temurin-21.0.13_9-jre"
  if [ ! -x "$dir/$jre_name/bin/java" ]; then
    mkdir -p "$dir"
    fetch_verified "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_x64_linux_hotspot_21.0.13_9.tar.gz" \
      "$jre_sha256" "$dir/jre.tar.gz"
    tar -xzf "$dir/jre.tar.gz" -C "$dir"
    rm -f "$dir/jre.tar.gz"
  fi
  export JAVA_HOME="$dir/$jre_name"
  PATH="$JAVA_HOME/bin:$PATH"
fi
export PATH

# The two scans: identifier rules and gitleaks' default rules, over the tree and over the
# commits this branch adds to origin/main.
l="$(git rev-parse --git-common-dir)/antwars-identifiers"
[ -s "$l" ] || { echo "full: the identifier list <git-common-dir>/antwars-identifiers is missing or empty; refusing." >&2; exit 1; }
b=$(git show origin/main:.githooks/pre-commit | sed -n "s/^defaults_baseline=\([0-9a-f]\{40\}\)\$/\1/p")
[ "$(printf "%s\n" "$b" | grep -c .)" = 1 ]
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
git cat-file blob "$b" > "$d/defaults.toml"
git cat-file blob origin/main:.githooks/identifier-config > "$d/identifier-config"
sh "$d/identifier-config" < "$l" > "$d/identifiers.toml"
mkdir "$d/tree" "$d/noignore"
g=$(git rev-parse --absolute-git-dir)
git archive HEAD | tar -x -C "$d/tree"
if [ -e "$d/tree/.gitleaksignore" ]; then mv "$d/tree/.gitleaksignore" "$d/tree/gitleaksignore.scanned"; fi
git rev-list --count origin/main..HEAD > /dev/null
for c in identifiers defaults; do
  (cd "$d/tree" && gitleaks dir . --gitleaks-ignore-path "$d/noignore" --no-banner --redact --ignore-gitleaks-allow --config "$d/$c.toml")
  gitleaks git "$g" --gitleaks-ignore-path "$d/noignore" --no-banner --redact --ignore-gitleaks-allow --config "$d/$c.toml" --log-opts="origin/main..HEAD --text --diff-merges=first-parent"
done
[ "$(git rev-parse -q --verify HEAD:.gitleaks-defaults.toml)" = "$b" ]

# Build and the full test set.
npm ci --no-audit --no-fund
npx tsc --noEmit
npm run build:web
firebase emulators:exec --only firestore "npx vitest run --maxWorkers=2"
