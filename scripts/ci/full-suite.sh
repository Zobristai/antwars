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
# Runs on Linux x86-64 only: every download below is the linux-x64 build. Needs Node.js 24, git,
# python3, coreutils and network access. The identifier list stays outside the repository, at
# <git-common-dir>/antwars-identifiers; without it the script refuses to run.
#
# Tools, each a release file pinned by SHA-256: gitleaks 8.30.1, firebase-tools 15.35.0 (the
# standalone release binary, not an npm install), an Eclipse Temurin Java 21 runtime, and the
# browsers the browser tests launch, at the builds playwright-core 1.61.1 uses: Chrome for
# Testing and Chrome Headless Shell 149.0.7827.55, and WebKit 26.5 (Playwright build 2311, made
# for Ubuntu 24.04). Downloads are kept in ANTWARS_CI_CACHE (an absolute path outside the
# checkout; default ${XDG_CACHE_HOME:-$HOME/.cache}/antwars-ci). On every run each one is copied
# into a private temporary directory and checked against its SHA-256 there before it is unpacked
# or run.
#
# WebKit also needs system libraries. Any that are not installed are fetched without root on
# Ubuntu 24.04: apt, with a private state directory, reads the Ubuntu archive snapshot of
# 2026-11-01, checks its signature with the system's Ubuntu archive keyring and each package
# against the signed index, and the packages are unpacked into the temporary directory (no
# package scripts run) for WebKit alone. Cached packages are checked against the signed index on
# every run. On another distribution, install them first as root with
# `npx playwright-core install-deps webkit`.
set -euo pipefail
umask 077

fail() { echo "full-suite: $*" >&2; exit 1; }
[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || fail "this script runs on Linux x86-64 only."
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

# unzip_to <zip> <directory>: unpacks with file modes, refusing absolute or parent paths and
# symlinks that point outside the directory.
unzip_to() {
  python3 -I - "$1" "$2" <<'PY'
import os, sys, zipfile
src, dest = sys.argv[1], os.path.realpath(sys.argv[2])
with zipfile.ZipFile(src) as zf:
    for i in zf.infolist():
        parts = i.filename.rstrip("/").split("/")
        if i.filename.startswith("/") or any(p in ("", ".", "..") for p in parts):
            sys.exit("full-suite: unsafe path in " + os.path.basename(src))
        out = os.path.join(dest, *parts)
        mode = i.external_attr >> 16
        if i.filename.endswith("/"):
            os.makedirs(out, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(out), exist_ok=True)
        if mode & 0o170000 == 0o120000:
            target = zf.read(i).decode()
            resolved = os.path.realpath(os.path.join(os.path.dirname(out), target))
            if os.path.isabs(target) or not resolved.startswith(dest + os.sep):
                sys.exit("full-suite: unsafe symlink in " + os.path.basename(src))
            os.symlink(target, out)
            continue
        with zf.open(i) as r, open(out, "xb") as w:
            while chunk := r.read(1 << 20):
                w.write(chunk)
        os.chmod(out, (mode & 0o700) or 0o600)
PY
}

# Browsers, at the builds playwright-core 1.61.1 (package-lock.json) uses.
cft=$(pinned https://storage.googleapis.com/chrome-for-testing-public/149.0.7827.55/linux64/chrome-linux64.zip \
  13113b963ac22fffdad898a677591028e4397c46c1daa9e61811258eed6e35b5 chrome-for-testing-149.0.7827.55-linux64.zip)
unzip_to "$cft" "$d/tools/chrome"
shell=$(pinned https://storage.googleapis.com/chrome-for-testing-public/149.0.7827.55/linux64/chrome-headless-shell-linux64.zip \
  410c9407d5de3fea80d9398666be06f2aa09154a3fa7b327dc254e336bb4c4b7 chrome-headless-shell-149.0.7827.55-linux64.zip)
unzip_to "$shell" "$d/tools/chrome-headless-shell"
wk=$(pinned https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2311/webkit-ubuntu-24.04.zip \
  b15753f528e990ca941cbd6d0c61a5dac09abcf04cbd8969ea077f1901aeac92 webkit-2311-ubuntu-24.04.zip)
unzip_to "$wk" "$d/tools/browsers/webkit-2311"
rm -f -- "$cft" "$shell" "$wk"
export CHROME_BIN="$d/tools/chrome/chrome-linux64/chrome"
export HEADLESS_SHELL="$d/tools/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell"
export PLAYWRIGHT_BROWSERS_PATH="$d/tools/browsers"

# WebKit's system libraries: the packages its build lists that are not installed, with their
# dependencies, from the pinned Ubuntu snapshot (see the top of this file).
wpe="$d/tools/browsers/webkit-2311/minibrowser-wpe"
missing=$(bash "$wpe/install-dependencies.sh" --printonly 2>&1 | sed -n 's/^Need to install the following extra packages: *//p')
if [ -n "$missing" ]; then
  os=$(. /etc/os-release && echo "${ID:-}-${VERSION_ID:-}")
  [ "$os" = ubuntu-24.04 ] && command -v apt-get > /dev/null && command -v dpkg-deb > /dev/null &&
    [ -f /usr/share/keyrings/ubuntu-archive-keyring.gpg ] ||
    fail "WebKit needs system packages that are not installed: $missing. Install them as root (npx playwright-core install-deps webkit), or run on Ubuntu 24.04, where this script fetches them."
  apt="$d/apt"
  mkdir -p -- "$apt/lists/partial" "$apt/archives/partial" "$apt/sources" "$apt/prefs" "$apt/dl" "$apt/debs" "$cache/debs"
  cat > "$apt/sources/noble.sources" << 'EOF'
Types: deb
URIs: https://snapshot.ubuntu.com/ubuntu/20261101T000000Z
Suites: noble noble-updates noble-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
  aptopts=(-o "Dir::State=$apt" -o Dir::State::status=/var/lib/dpkg/status -o "Dir::Cache=$apt"
    -o Dir::Etc::sourcelist=/dev/null -o "Dir::Etc::sourceparts=$apt/sources" -o "Dir::Etc::preferencesparts=$apt/prefs"
    -o "APT::Sandbox::User=$(id -un)" -o Debug::NoLocking=1 -o Acquire::Languages=none)
  apt-get "${aptopts[@]}" -qq update > /dev/null
  # Packages to unpack: only those not installed at all (upgrades of installed ones are skipped).
  # shellcheck disable=SC2086
  apt-get "${aptopts[@]}" -s --no-install-recommends install $missing 2> /dev/null |
    sed -n 's/^Inst \([^ ]*\) (\([^ ]*\) .*/\1=\2/p' > "$apt/specs"
  [ -s "$apt/specs" ] || fail "could not resolve WebKit's system packages from the Ubuntu snapshot."
  # Each package's SHA-256 from the signed index, as "<sha256> <package>=<version>".
  # shellcheck disable=SC2046
  apt-cache "${aptopts[@]}" show $(cat "$apt/specs") |
    awk '/^Package: /{p=$2} /^Version: /{v=$2} /^SHA256: /{print $2, p "=" v}' | sort -u > "$apt/sums"
  [ "$(wc -l < "$apt/sums")" = "$(wc -l < "$apt/specs")" ] || fail "the Ubuntu snapshot index does not list every WebKit system package once."
  # use_cached: copies every cached package into the temporary directory and checks it there;
  # prints the packages still missing or mismatched.
  use_cached() {
    local sum spec
    while read -r sum spec; do
      [ -f "$apt/debs/$sum.deb" ] && continue
      if [ -f "$cache/debs/$sum.deb" ] && [ ! -L "$cache/debs/$sum.deb" ]; then
        cp -- "$cache/debs/$sum.deb" "$apt/debs/$sum.deb"
        echo "$sum  $apt/debs/$sum.deb" | sha256sum -c --quiet - > /dev/null 2>&1 && continue
        rm -f -- "$cache/debs/$sum.deb" "$apt/debs/$sum.deb"
      fi
      echo "$spec"
    done < "$apt/sums"
  }
  need=$(use_cached)
  if [ -n "$need" ]; then
    # apt checks each download against the signed index; it is filed in the cache by its SHA-256.
    # shellcheck disable=SC2086
    (cd "$apt/dl" && apt-get "${aptopts[@]}" -qq download $need > /dev/null)
    for f in "$apt/dl"/*.deb; do
      sum=$(sha256sum -- "$f" | cut -d' ' -f1)
      mv -- "$f" "$cache/debs/$sum.deb.$$" && mv -- "$cache/debs/$sum.deb.$$" "$cache/debs/$sum.deb"
    done
    [ -z "$(use_cached)" ] || fail "a WebKit system package does not match the Ubuntu snapshot's signed index."
  fi
  lib="$d/tools/webkit-deps"
  mkdir -- "$lib"
  for f in "$apt/debs"/*.deb; do dpkg-deb -x "$f" "$lib"; done
  rm -rf -- "$apt"
  # WebKit's own launcher sets its library path; this one adds the unpacked libraries for WebKit
  # alone. Playwright cannot see them, so its host check is skipped.
  multiarch="$lib/usr/lib/x86_64-linux-gnu"
  cat > "$wpe/MiniBrowser" << EOF
#!/bin/sh
MYDIR="$wpe"
export WEBKIT_EXEC_PATH="\${MYDIR}/bin"
export WEBKIT_INJECTED_BUNDLE_PATH="\${MYDIR}/lib"
export WEBKIT_INSPECTOR_RESOURCES_PATH="\${MYDIR}/share"
export LD_LIBRARY_PATH="\${MYDIR}/lib:\${MYDIR}/sys/lib:$multiarch"
export GST_PLUGIN_SYSTEM_PATH="$multiarch/gstreamer-1.0"
export GST_REGISTRY="$d/tools/gstreamer-registry.bin"
export GIO_EXTRA_MODULES="$multiarch/gio/modules"
export LIBGL_DRIVERS_PATH="$multiarch/dri"
export __EGL_VENDOR_LIBRARY_DIRS="$lib/usr/share/glvnd/egl_vendor.d"
exec "\${MYDIR}/bin/MiniBrowser" "\$@"
EOF
  chmod 700 -- "$wpe/MiniBrowser"
  export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
fi

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
