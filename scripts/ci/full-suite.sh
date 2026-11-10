#!/usr/bin/env bash
# Runs the full local check from the repository root: the private identifier scan and gitleaks'
# default rules, then npm ci, the typecheck, the web build and the full test set against the
# Firestore emulator.
#
# The two scans are the gitleaks workflow's own .github/scripts/identifiers-scan.sh, taken from
# origin/main as git objects (with .githooks/identifier-config and .gitleaks-defaults.toml), so
# the code that reads the identifier list is the reviewed base, never the checkout being tested.
# It writes every committed blob of HEAD as plain data (no export attributes, symlinks written as
# their target text) and scans that tree and the commits in origin/main..HEAD, once with the
# identifier rules and once with the default rules. Each finding is reported only as its scan,
# rule, commit, line and the sha256 of its path (CONTRIBUTING.md says how to find the file).
#
# Needs Node.js 24, git, python3, coreutils and network access. The identifier list stays outside
# the repository, at <git-common-dir>/antwars-identifiers; without it the script refuses to run.
#
# Tools: gitleaks 8.30.1, firebase-tools 15.35.0 (the standalone release binary) and an Eclipse
# Temurin Java 21 runtime, each a release file pinned by SHA-256. Downloads are kept in
# ANTWARS_CI_CACHE (an absolute path outside the checkout; default
# ${XDG_CACHE_HOME:-$HOME/.cache}/antwars-ci). On every run each one is copied into a private
# temporary directory and checked against its SHA-256 there before it is unpacked or run.
set -euo pipefail
umask 077

fail() { echo "full-suite: $*" >&2; exit 1; }
for tool in git node python3 sha256sum realpath tar; do
  command -v "$tool" > /dev/null || fail "$tool is not installed."
done

top=$(git rev-parse --show-toplevel)
common=$(git rev-parse --path-format=absolute --git-common-dir)
gitdir=$(git rev-parse --path-format=absolute --absolute-git-dir)
# outside <path>: true when the path, resolved, is not inside the checkout or its Git directories.
outside() {
  local p r
  p=$(realpath -m -- "$1")
  for r in "$top" "$common" "$gitdir"; do
    r=$(realpath -m -- "$r")
    case "$p/" in "$r"/*) return 1 ;; esac
  done
}

# Cache: absolute, outside the checkout, a real directory owned by this user, private.
cache="${ANTWARS_CI_CACHE:-${XDG_CACHE_HOME:-${HOME:?}/.cache}/antwars-ci}"
case "$cache" in /*) ;; *) fail "the cache path must be absolute (set ANTWARS_CI_CACHE)." ;; esac
outside "$cache" || fail "the cache path must be outside the checkout and its Git directory."
mkdir -p -- "$cache"
[ -d "$cache" ] && [ ! -L "$cache" ] && [ -O "$cache" ] || fail "the cache path must be a directory owned by you, not a symlink."
chmod 700 -- "$cache"

# Private temporary directory outside the checkout, removed however the script ends.
tmpbase=${TMPDIR:-/tmp}
case "$tmpbase" in /*) ;; *) tmpbase=/tmp ;; esac
outside "$tmpbase" || tmpbase=/tmp
d=$(mktemp -d -- "$tmpbase/antwars-full.XXXXXXXX")
trap 'rm -rf -- "$d"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
outside "$d" || fail "the temporary directory must be outside the checkout."
chmod 700 -- "$d"
mkdir -- "$d/tools" "$d/tools/bin"

# pinned <url> <sha256> <name>: prints the path of a private copy of the release file, checked
# against its SHA-256 after copying. A missing or mismatched cache entry is downloaded again.
pinned() {
  local url=$1 sum=$2 name=$3
  local cached="$cache/$sum-$name" copy="$d/tools/$name"
  local attempt
  for attempt in 1 2; do
    if [ ! -f "$cached" ] || [ -L "$cached" ]; then
      rm -f -- "$cached"
      node --input-type=module -e '
        import { createHash } from "node:crypto";
        import { renameSync, writeFileSync } from "node:fs";
        const [url, sum, out] = process.argv.slice(1);
        const res = await fetch(url);
        if (!res.ok) { console.error(`full-suite: download failed (${res.status}): ${url}`); process.exit(1); }
        const buf = Buffer.from(await res.arrayBuffer());
        if (createHash("sha256").update(buf).digest("hex") !== sum) {
          console.error(`full-suite: checksum mismatch for ${url}`); process.exit(1);
        }
        const part = `${out}.${process.pid}.part`;
        writeFileSync(part, buf, { mode: 0o600 });
        renameSync(part, out);
      ' "$url" "$sum" "$cached" >&2
    fi
    cp -- "$cached" "$copy"
    if echo "$sum  $copy" | sha256sum -c --quiet - > /dev/null 2>&1; then
      echo "$copy"
      return 0
    fi
    rm -f -- "$cached" "$copy"
  done
  fail "$name does not match its pinned SHA-256."
}

gl=$(pinned https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb gitleaks_8.30.1_linux_x64.tar.gz)
tar -xzf "$gl" -C "$d/tools/bin" gitleaks

fb=$(pinned https://github.com/firebase/firebase-tools/releases/download/v15.35.0/firebase-tools-linux \
  0bce2a1b10411445c47d00f9c46cba49b89b59fd47f8f860f291c0d12b7ac649 firebase-tools-15.35.0-linux)
mv -- "$fb" "$d/tools/bin/firebase"
chmod 700 -- "$d/tools/bin/firebase"

jre=$(pinned https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_x64_linux_hotspot_21.0.13_9.tar.gz \
  a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd OpenJDK21U-jre_x64_linux_hotspot_21.0.13_9.tar.gz)
mkdir -- "$d/tools/jre"
tar -xzf "$jre" -C "$d/tools/jre"
export JAVA_HOME="$d/tools/jre/jdk-21.0.13+9-jre"
export PATH="$d/tools/bin:$JAVA_HOME/bin:$PATH"
rm -f -- "$gl" "$jre"

# The scans.
list="$common/antwars-identifiers"
[ -s "$list" ] || fail "the identifier list <git-common-dir>/antwars-identifiers is missing or empty; refusing."
base=$(git rev-parse --verify 'origin/main^{commit}')
candidate=$(git rev-parse --verify 'HEAD^{commit}')
pin=$(git cat-file blob "$base:.githooks/pre-commit" | sed -n 's/^defaults_baseline=\([0-9a-f]\{40\}\)$/\1/p')
[ "$(printf '%s\n' "$pin" | grep -c .)" = 1 ] || fail "origin/main's .githooks/pre-commit has no single defaults_baseline line."
[ "$(git rev-parse -q --verify "$candidate:.gitleaks-defaults.toml" || true)" = "$pin" ] ||
  fail "HEAD's .gitleaks-defaults.toml is not the approved default-rules config named in origin/main's .githooks/pre-commit."

# A private repository whose HEAD is origin/main, sharing this clone's objects, holding only the
# base's scanner, identifier-config and defaults config. Nothing from HEAD's files is run.
git init -q -b base -- "$d/base"
echo "$common/objects" > "$d/base/.git/objects/info/alternates"
git -C "$d/base" update-ref refs/heads/base "$base"
for f in .github/scripts/identifiers-scan.sh .githooks/identifier-config .gitleaks-defaults.toml; do
  mkdir -p -- "$d/base/$(dirname "$f")"
  git cat-file blob "$base:$f" > "$d/base/$f"
done

status=0
ANTWARS_IDENTIFIERS=$(cat -- "$list") bash "$d/base/.github/scripts/identifiers-scan.sh" "$d/work" "$candidate" "$base" || status=$?
# Report the reduced findings: scan, rule, commit, line and path sha256 only.
node --input-type=module -e '
  import { existsSync, readFileSync } from "node:fs";
  const dir = process.argv[1];
  const ran = existsSync(`${dir}/ran.txt`) ? readFileSync(`${dir}/ran.txt`, "utf8").split("\n").filter(Boolean) : [];
  let total = 0;
  for (const scan of ran) {
    const file = `${dir}/${scan}.json`;
    let items = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : "missing";
    if (!Array.isArray(items)) { console.log(`full-suite: scan=${scan} report ${items}`); total++; continue; }
    console.log(`full-suite: scan=${scan} findings=${items.length}`);
    for (const f of items) {
      total++;
      console.log(`full-suite: finding: scan=${scan} rule=${f.RuleID} commit=${f.Commit || "-"} line=${f.StartLine} path-sha256=${f.PathSHA256}`);
    }
  }
  if (ran.length === 0) console.log("full-suite: no scan ran.");
' "$d/work/reports"
[ "$status" = 0 ] || fail "the private identifier or default-rules scan failed."
rm -rf -- "$d/work" "$d/base"

# Build and the full test set.
npm ci --no-audit --no-fund
npx tsc --noEmit
npm run build:web
firebase emulators:exec --only firestore "npx vitest run --maxWorkers=2"
