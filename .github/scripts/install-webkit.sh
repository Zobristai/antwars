#!/usr/bin/env bash
# Installs Playwright's WebKit browser and its system packages for the test steps
# (.github/workflows/antwar-ci.yml), with each attempt bounded so a stalled download
# cannot run until the job's time limit.
#
# Each attempt runs `npx playwright-core install --with-deps webkit` under `timeout`,
# which stops the whole attempt (apt included) when its limit passes. Between attempts an
# interrupted package install is finished with `dpkg --configure -a`. After the last failed
# attempt the script prints an error and exits non-zero, so the step fails promptly.
#
# Environment (both optional):
#   WEBKIT_INSTALL_ATTEMPTS         number of attempts (default 3)
#   WEBKIT_INSTALL_ATTEMPT_SECONDS  limit for each attempt in seconds (default 480)
set -uo pipefail

attempts="${WEBKIT_INSTALL_ATTEMPTS:-3}"
limit="${WEBKIT_INSTALL_ATTEMPT_SECONDS:-480}"

for ((attempt = 1; attempt <= attempts; attempt++)); do
  echo "WebKit install: attempt ${attempt} of ${attempts} (limit ${limit} s)"
  started=$SECONDS
  timeout --kill-after=30 "${limit}" npx playwright-core install --with-deps webkit
  status=$?
  elapsed=$((SECONDS - started))
  if [ "${status}" -eq 0 ]; then
    echo "WebKit install: done on attempt ${attempt} in ${elapsed} s"
    exit 0
  fi
  if [ "${status}" -eq 124 ] || [ "${status}" -eq 137 ]; then
    echo "::warning::WebKit install attempt ${attempt} stopped at its ${limit} s limit"
  else
    echo "::warning::WebKit install attempt ${attempt} failed (exit ${status}) after ${elapsed} s"
  fi
  if [ "${attempt}" -lt "${attempts}" ]; then
    # Finish any package install the stopped attempt left half done; its own failure
    # does not stop the next attempt.
    sudo dpkg --configure -a || echo "::warning::dpkg --configure -a failed; trying the next attempt anyway"
  fi
done

echo "::error::WebKit install failed in all ${attempts} attempts (each limited to ${limit} s)"
exit 1
