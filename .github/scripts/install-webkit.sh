#!/usr/bin/env bash
# Installs Playwright's WebKit browser and its system packages for the test steps
# (.github/workflows/antwar-ci.yml), with every part bounded so a stalled download
# cannot run until the job's time limit. Run from the repository root after `npm ci`.
#
# Each attempt does what `playwright-core install --with-deps webkit` does, in two parts:
#   1. `install-deps webkit` (the apt packages), run as root under a root `timeout`. As root,
#      Playwright runs apt-get itself instead of through sudo, so apt and dpkg stay in the
#      group the root `timeout` stops when the limit passes.
#   2. `install webkit` (the browser download), run as the runner user under `timeout`.
# After a failed package part, any process still holding an apt or dpkg lock is killed as
# root, then `dpkg --configure -a` (itself time-limited) finishes an interrupted install.
# After the last failed attempt the script prints an error and exits non-zero.
#
# Environment (all optional):
#   WEBKIT_INSTALL_ATTEMPTS          number of attempts (default 3)
#   WEBKIT_INSTALL_ATTEMPT_SECONDS   limit for each part of an attempt in seconds (default 300)
#   WEBKIT_RECOVERY_SECONDS          limit for `dpkg --configure -a` in seconds (default 60)
set -uo pipefail

attempts="${WEBKIT_INSTALL_ATTEMPTS:-3}"
limit="${WEBKIT_INSTALL_ATTEMPT_SECONDS:-300}"
recovery_limit="${WEBKIT_RECOVERY_SECONDS:-60}"
grace=15
node_bin="$(command -v node)"
cli="node_modules/playwright-core/cli.js"
locks=(/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock)

if [ ! -f "${cli}" ]; then
  echo "::error::${cli} not found; run this from the repository root after npm ci"
  exit 1
fi

# Prints why a bounded command failed. $1 = what, $2 = exit status, $3 = its limit in seconds.
report_failure() {
  if [ "$2" -eq 124 ] || [ "$2" -eq 137 ]; then
    echo "::warning::$1 stopped at its $3 s limit"
  else
    echo "::warning::$1 failed (exit $2)"
  fi
}

# Kills, as root, every process still holding an apt or dpkg lock, and waits until none does.
release_package_locks() {
  if ! command -v fuser >/dev/null; then
    echo "::warning::fuser not found; cannot check for leftover apt or dpkg processes"
    return
  fi
  for ((wait = 0; wait < 30; wait++)); do
    if ! sudo -n fuser -s "${locks[@]}" 2>/dev/null; then
      return
    fi
    sudo -n fuser -k -KILL "${locks[@]}" >/dev/null 2>&1
    sleep 1
  done
  echo "::warning::a process still holds an apt or dpkg lock after 30 s"
}

for ((attempt = 1; attempt <= attempts; attempt++)); do
  echo "WebKit install: attempt ${attempt} of ${attempts} (limit ${limit} s per part)"
  started=$SECONDS

  sudo -n timeout --kill-after="${grace}" "${limit}" "${node_bin}" "${cli}" install-deps webkit
  status=$?
  if [ "${status}" -eq 0 ]; then
    timeout --kill-after="${grace}" "${limit}" "${node_bin}" "${cli}" install webkit
    status=$?
    if [ "${status}" -eq 0 ]; then
      echo "WebKit install: done on attempt ${attempt} in $((SECONDS - started)) s"
      exit 0
    fi
    report_failure "WebKit browser download, attempt ${attempt}," "${status}" "${limit}"
    continue
  fi

  report_failure "WebKit system packages, attempt ${attempt}," "${status}" "${limit}"
  if [ "${attempt}" -lt "${attempts}" ]; then
    # Clear what the stopped attempt left behind; a failure here only warns, and the next
    # attempt still runs.
    release_package_locks
    sudo -n timeout --kill-after="${grace}" "${recovery_limit}" dpkg --configure -a
    status=$?
    if [ "${status}" -ne 0 ]; then
      report_failure "dpkg --configure -a" "${status}" "${recovery_limit}"
      release_package_locks
    fi
  fi
done

echo "::error::WebKit install failed in all ${attempts} attempts (each part limited to ${limit} s)"
exit 1
