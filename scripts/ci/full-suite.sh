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
# Runs on Ubuntu 24.04 x86-64 only, and refuses to run elsewhere: the browsers and their system
# libraries below are the Ubuntu 24.04 x86-64 builds. Needs Node.js 24, git, python3, coreutils,
# util-linux, apt and network access; no root. The identifier list stays outside the repository,
# at <git-common-dir>/antwars-identifiers; without it the script refuses to run.
#
# npm ci, the typecheck, the build and the tests run the checkout's own code and its
# dependencies', so they run where the identifier list cannot be read: in unprivileged user,
# mount and PID namespaces where an empty read-only file is mounted over the list (and over any
# other path that reaches the same file), then in a further user and mount namespace mapped back
# to your own user, with no capabilities, where that mount is locked and cannot be removed. The
# script checks all of this before running anything from the checkout, and refuses to run where
# those namespaces cannot be created: on Ubuntu 24.04 that is the default, so it needs
# kernel.apparmor_restrict_unprivileged_userns=0, or an AppArmor profile that allows user
# namespaces for unshare.
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
# The browsers also need system libraries: the packages WebKit's build lists and those
# playwright-core 1.61.1 lists for Chromium on Ubuntu 24.04. Any that are not installed are
# fetched without root: apt, with a private state directory, reads the Ubuntu archive snapshot of
# 2026-11-01, checks its signature with the system's Ubuntu archive keyring and each package
# against the signed index, and the packages are unpacked into the temporary directory (no
# package scripts run), where only the browsers' launchers use them. Cached packages are checked
# against the signed index on every run.
#
# The tests run in three steps, like the full job of the `antwar ci` workflow: the full
# set except the Wide Plain handover and the deploy tooling tests, against the Firestore
# emulator; then the Wide Plain handover on its own; then the deploy tooling tests on their own.
# Every step runs even when an earlier one fails, and the script fails if any of them does.
set -euo pipefail
umask 077

fail() { echo "full-suite: $*" >&2; exit 1; }
os=$( (. /etc/os-release && echo "${ID:-}-${VERSION_ID:-}") 2> /dev/null || true)
[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] && [ "$os" = ubuntu-24.04 ] ||
  fail "this script runs on Ubuntu 24.04 x86-64 only: its browsers and their system libraries are the Ubuntu 24.04 x86-64 builds."
for tool in git node python3 sha256sum realpath tar apt-get apt-cache dpkg-query dpkg-deb unshare mount; do
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
# private_dir <dir> <what>: creates the directory if missing, then refuses it unless it is a real
# directory (not a symlink) owned by this user; makes it private.
private_dir() {
  mkdir -p -- "$1"
  [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] || fail "$2 must be a directory owned by you, not a symlink."
  chmod 700 -- "$1"
}
private_dir "$cache" "the cache path"
cache=$(realpath -e -- "$cache")

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

list="$common/antwars-identifiers"
[ -s "$list" ] || fail "the identifier list <git-common-dir>/antwars-identifiers is missing or empty; refusing."

# hidden <command...>: runs the command where the identifier list cannot be read. First stage, as
# root of new user, mount and PID namespaces (with their own /proc): an empty read-only file is
# mounted over the list and over every other path at which a mount shows the same file. Second
# stage, in a further user and mount namespace mapped back to your own user: that mount is locked
# there, and the user has no capabilities. Before the command runs, the second stage checks that
# no path still reaches the list, that the covering mounts cannot be removed, that it holds no
# capabilities and that the script's own processes are not visible. Any failed check refuses.
cat > "$d/hide.py" << 'PY'
import ctypes, os, re, subprocess, sys

def die(msg):
    sys.stderr.write("full-suite: " + msg + "\n")
    sys.exit(1)

def same(path, ident):
    try:
        st = os.stat(path)
    except OSError:
        return False
    return (st.st_dev, st.st_ino) == ident

stage = sys.argv[1]
if stage == "outer":
    lst, empty, uid, gid, pidns = sys.argv[2:7]
    cmd = sys.argv[8:]
    lst = os.path.realpath(lst)
    st = os.stat(lst)
    if st.st_nlink != 1:
        die("the identifier list has more than one hard link; refusing.")
    ident = (st.st_dev, st.st_ino)
    dev = "%d:%d" % (os.major(st.st_dev), os.minor(st.st_dev))
    unesc = lambda s: re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), s)
    mounts = []
    with open("/proc/self/mountinfo") as f:
        for line in f:
            fields = line.split()
            if fields[2] == dev:
                mounts.append((unesc(fields[3]), unesc(fields[4])))
    inside = lambda path, top: top == "/" or path == top or path.startswith(top + "/")
    hosts = [m for m in mounts if inside(lst, m[1])]
    if not hosts:
        die("cannot find the mount that holds the identifier list; refusing.")
    root, point = max(hosts, key=lambda m: len(m[1]))
    fspath = os.path.normpath(root + "/" + os.path.relpath(lst, point))
    paths = {lst}
    for root, point in mounts:
        if inside(fspath, root):
            paths.add(os.path.normpath(point + "/" + os.path.relpath(fspath, root)))
    covered = []
    for path in sorted(paths):
        if not same(path, ident):
            continue
        for args in (["--bind", empty, path], ["-o", "remount,bind,ro", path]):
            if subprocess.run(["mount", *args], stderr=subprocess.DEVNULL).returncode != 0:
                die("cannot mount over the identifier list; refusing.")
        covered.append(path)
    if lst not in covered or any(same(p, ident) for p in paths):
        die("the identifier list is still reachable; refusing.")
    os.execvp("unshare", ["unshare", "--user", "--map-user=" + uid, "--map-group=" + gid, "--mount", "--",
                          sys.executable, "-I", __file__, "inner", str(ident[0]), str(ident[1]), pidns,
                          *covered, "--", *cmd])
elif stage == "inner":
    ident = (int(sys.argv[2]), int(sys.argv[3]))
    pidns = sys.argv[4]
    split = sys.argv.index("--")
    covered, cmd = sys.argv[5:split], sys.argv[split + 1:]
    libc = ctypes.CDLL(None, use_errno=True)
    with open("/proc/self/status") as f:
        caps = [l.split()[1] for l in f if l.startswith(("CapEff:", "CapPrm:"))]
    if os.geteuid() == 0 or any(int(c, 16) for c in caps):
        die("the build and tests would hold privileges; refusing.")
    if os.readlink("/proc/self/ns/pid") == pidns:
        die("the build and tests would see the script's own processes; refusing.")
    for path in covered:
        if same(path, ident):
            die("the identifier list is still reachable; refusing.")
        with open(path, "rb") as f:
            if f.read(1):
                die("the identifier list is still readable; refusing.")
        for flags in (0, 2):
            if libc.umount2(path.encode(), flags) == 0:
                die("the mount over the identifier list could be removed; refusing.")
    os.execvp(cmd[0], cmd)
PY
: > "$d/empty"
chmod 400 -- "$d/empty"
hidden() {
  unshare --user --map-root-user --mount --pid --fork --mount-proc --propagation private -- \
    python3 -I "$d/hide.py" outer "$list" "$d/empty" "$(id -u)" "$(id -g)" "$(readlink /proc/self/ns/pid)" -- "$@"
}
# Refuse now, before anything is downloaded, where the namespaces cannot be created.
hidden true 2> /dev/null ||
  fail "cannot hide the identifier list from the build and tests: this machine refuses unprivileged user, mount or PID namespaces (on Ubuntu 24.04, set kernel.apparmor_restrict_unprivileged_userns=0 or allow user namespaces for unshare in AppArmor)."

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
export PLAYWRIGHT_BROWSERS_PATH="$d/tools/browsers"

# Each Chrome build runs through a launcher that adds the unpacked system libraries (below) for
# that browser alone. The launcher is fixed text: it finds its directories from its own location
# at run time, so no path is written into it.
for bin in "$d/tools/chrome/chrome-linux64/chrome" \
  "$d/tools/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell"; do
  cat > "$bin-run" << 'EOF'
#!/bin/sh
SELF=$(readlink -f -- "$0")
TOOLS=$(cd -- "$(dirname -- "$SELF")/../.." && pwd -P)
LD_LIBRARY_PATH="$TOOLS/browser-deps/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" exec "${SELF%-run}" "$@"
EOF
  chmod 700 -- "$bin-run"
done
export CHROME_BIN="$d/tools/chrome/chrome-linux64/chrome-run"
export HEADLESS_SHELL="$d/tools/chrome-headless-shell/chrome-headless-shell-linux64/chrome-headless-shell-run"
mkdir -- "$d/tools/browser-deps"

# The browsers' system libraries, from the pinned Ubuntu snapshot (see the top of this file): the
# packages WebKit's build lists, and the packages playwright-core 1.61.1 lists for Chromium on
# Ubuntu 24.04, that are not installed, with their dependencies.
wpe="$d/tools/browsers/webkit-2311/minibrowser-wpe"
missing=$(bash "$wpe/install-dependencies.sh" --printonly 2>&1 | sed -n 's/^Need to install the following extra packages: *//p')
for pkg in libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
  libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2; do
  [ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg:amd64" 2> /dev/null)" = installed ] || missing="$missing $pkg:amd64"
done
missing=$(printf '%s\n' $missing | sort -u | tr '\n' ' ')
if [ -n "${missing// /}" ]; then
  [ -f /usr/share/keyrings/ubuntu-archive-keyring.gpg ] ||
    fail "the browsers need system packages that are not installed ($missing), and the Ubuntu archive keyring to fetch them is missing."
  apt="$d/apt"
  mkdir -p -- "$apt/lists/partial" "$apt/archives/partial" "$apt/sources" "$apt/prefs" "$apt/dl" "$apt/debs"
  # The package cache gets the same checks as the cache root, and must resolve to a directory
  # directly inside it, before anything in it is read, deleted or written.
  private_dir "$cache/debs" "the package cache $cache/debs"
  [ "$(realpath -e -- "$cache/debs")" = "$cache/debs" ] || fail "the package cache must be inside the cache directory."
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
  [ -s "$apt/specs" ] || fail "could not resolve the browsers' system packages from the Ubuntu snapshot."
  # Each package's SHA-256 from the signed index, as "<sha256> <package>=<version>".
  # shellcheck disable=SC2046
  apt-cache "${aptopts[@]}" show $(cat "$apt/specs") |
    awk '/^Package: /{p=$2} /^Version: /{v=$2} /^SHA256: /{print $2, p "=" v}' | sort -u > "$apt/sums"
  [ "$(wc -l < "$apt/sums")" = "$(wc -l < "$apt/specs")" ] || fail "the Ubuntu snapshot index does not list every browser system package once."
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
    [ -z "$(use_cached)" ] || fail "a browser system package does not match the Ubuntu snapshot's signed index."
  fi
  lib="$d/tools/browser-deps"
  for f in "$apt/debs"/*.deb; do dpkg-deb -x "$f" "$lib"; done
  rm -rf -- "$apt"
  # WebKit's own launcher sets its library path; this one adds the unpacked libraries for WebKit
  # alone. Playwright cannot see them, so its host check is skipped. The launcher is fixed text:
  # it finds every directory from its own location at run time, so no path is written into it.
  cat > "$wpe/MiniBrowser" << 'EOF'
#!/bin/sh
MYDIR=$(dirname -- "$(readlink -f -- "$0")")
TOOLS=$(cd -- "$MYDIR/../../.." && pwd -P)
LIB="$TOOLS/browser-deps/usr/lib/x86_64-linux-gnu"
export WEBKIT_EXEC_PATH="$MYDIR/bin"
export WEBKIT_INJECTED_BUNDLE_PATH="$MYDIR/lib"
export WEBKIT_INSPECTOR_RESOURCES_PATH="$MYDIR/share"
export LD_LIBRARY_PATH="$MYDIR/lib:$MYDIR/sys/lib:$LIB"
export GST_PLUGIN_SYSTEM_PATH="$LIB/gstreamer-1.0"
export GST_REGISTRY="$TOOLS/gstreamer-registry.bin"
export GIO_EXTRA_MODULES="$LIB/gio/modules"
export LIBGL_DRIVERS_PATH="$LIB/dri"
export __EGL_VENDOR_LIBRARY_DIRS="$TOOLS/browser-deps/usr/share/glvnd/egl_vendor.d"
exec "$MYDIR/bin/MiniBrowser" "$@"
EOF
  chmod 700 -- "$wpe/MiniBrowser"
  export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
fi

# The scans.
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

# Nothing the scanner or gitleaks prints is written anywhere: gitleaks' own log and error lines
# can carry file paths. The scanner's output is discarded. gitleaks runs through the wrapper
# below, which reads its messages through a pipe, never stores or prints them, and only checks
# them: a scan is complete when gitleaks printed nothing but its completion messages (scanned,
# commits scanned, no leaks found, leaks found) and exactly one "scanned" line. Anything else,
# such as a file it could not read or a git error, marks that scan incomplete, and the run fails.
# gitleaks can report such errors and still exit 0.
mkdir -- "$d/scanbin"
cat > "$d/scanbin/gitleaks" << 'EOF'
#!/usr/bin/env bash
set -uo pipefail
dir=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
report=
prev=
for arg in "$@"; do
  [ "$prev" = --report-path ] && report=$(basename -- "$arg")
  prev=$arg
done
{ "$dir/tools/bin/gitleaks" "$@" 2>&1; printf '\001exit %d\n' "$?"; } | LC_ALL=C awk '
  BEGIN { code = 3; bad = 0; scanned = 0; done = 0 }
  /^\001exit [0-9]+$/ { code = substr($0, 7) + 0; done = 1; next }
  {
    if (done) { bad = 1; next }
    gsub(/\033\[[0-9;]*m/, "")
    if (!sub(/^[0-9][0-9]?:[0-9][0-9][AP]M /, "")) { bad = 1; next }
    if ($0 ~ /^INF scanned ~[0-9]+ bytes \([0-9.]+( [A-Za-z]+)?\) in [0-9][^ ]*$/) { scanned++; next }
    if ($0 ~ /^INF [0-9]+ commits scanned\.$/ || $0 == "INF no leaks found" || $0 ~ /^WRN leaks found: [0-9]+$/) next
    bad = 1
  }
  END { exit (bad || !done || scanned != 1) ? 3 : code }
'
code=$?
if [ "$code" = 3 ]; then
  case "$report" in *[!a-z.-]* | "") report=unknown.json ;; esac
  echo "${report%.json}" >> "$dir/incomplete.txt"
fi
exit "$code"
EOF
chmod 700 -- "$d/scanbin/gitleaks"
: > "$d/incomplete.txt"
# The scans that must have run: the tree and the commits, with each rule set, and the candidate's
# .gitleaksignore as a file when it has one.
expected="tree commits tree-defaults commits-defaults"
if git cat-file -e "$candidate:.gitleaksignore" 2> /dev/null; then
  expected="$expected ignore ignore-defaults"
fi

status=0
PATH="$d/scanbin:$PATH" ANTWARS_IDENTIFIERS=$(cat -- "$list") \
  bash "$d/base/.github/scripts/identifiers-scan.sh" "$d/work" "$candidate" "$base" > /dev/null 2>&1 || status=$?
# Report the reduced findings: scan, rule, commit, line and path sha256 only, each field checked
# against its expected form. A scan that did not run, did not complete, or left a missing or
# unreadable report fails the run.
node --input-type=module -e '
  import { existsSync, readFileSync } from "node:fs";
  const [dir, incompleteFile, expectedList] = process.argv.slice(1);
  const safe = (v, re) => (typeof v === "string" && re.test(v) ? v : null);
  const lines = (file) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const ran = lines(`${dir}/ran.txt`);
  const incomplete = new Set(lines(incompleteFile));
  let ok = true;
  for (const scan of expectedList.split(" ")) {
    if (!ran.includes(scan)) { console.log(`full-suite: scan=${scan} did not run`); ok = false; }
  }
  for (const name of ran) {
    const scan = safe(name, /^[a-z-]+$/);
    if (!scan) { console.log("full-suite: scan=unknown report unreadable"); ok = false; continue; }
    if (incomplete.has(scan)) { console.log(`full-suite: scan=${scan} incomplete`); ok = false; }
    let items = "missing";
    if (existsSync(`${dir}/${scan}.json`)) {
      try { items = JSON.parse(readFileSync(`${dir}/${scan}.json`, "utf8")); } catch { items = "unreadable"; }
    }
    if (!Array.isArray(items)) { console.log(`full-suite: scan=${scan} report ${items === "missing" ? "missing" : "unreadable"}`); ok = false; continue; }
    console.log(`full-suite: scan=${scan} findings=${items.length}`);
    for (const f of items) {
      const rule = safe(f?.RuleID, /^[A-Za-z0-9._-]+$/) ?? "rule-redacted";
      const commit = safe(f?.Commit, /^[0-9a-f]{40}$/) ?? "-";
      const line = Number.isInteger(f?.StartLine) ? f.StartLine : 0;
      const path = safe(f?.PathSHA256, /^[0-9a-f]{64}$/) ?? "path-redacted";
      console.log(`full-suite: finding: scan=${scan} rule=${rule} commit=${commit} line=${line} path-sha256=${path}`);
    }
  }
  for (const scan of incomplete) {
    if (!ran.includes(scan)) { console.log("full-suite: a scan did not complete"); ok = false; }
  }
  process.exit(ok ? 0 : 1);
' "$d/work/reports" "$d/incomplete.txt" "$expected" || status=1
[ "$status" = 0 ] || fail "the private identifier or default-rules scan failed or did not complete."
rm -rf -- "$d/work" "$d/base"

# Build and the full test set, where the identifier list cannot be read (hidden, above).
build_and_test() {
  set -euo pipefail
  npm ci --no-audit --no-fund
  npx tsc --noEmit
  npm run build:web
  # The tests, split as the full job of .github/workflows/antwar-ci.yml splits them: beside the
  # rest of the suite, the Wide Plain handover's pause and the deploy tooling tests' many
  # fake-deploy processes starve each other past their time limits.
  local tests=0
  ANTWAR_REQUIRE_EMULATOR=1 firebase emulators:exec --only firestore \
    "npx vitest run --maxWorkers=2 --exclude test/slots/handover-wide-plain.test.ts --exclude deploy/cloud-run/deploy.test.ts" || tests=1
  npx vitest run test/slots/handover-wide-plain.test.ts || tests=1
  npx vitest run deploy/cloud-run/deploy.test.ts || tests=1
  [ "$tests" = 0 ] || { echo "full-suite: the full test set failed." >&2; exit 1; }
}
export -f build_and_test
hidden bash -c build_and_test || fail "the build or the full test set failed."
