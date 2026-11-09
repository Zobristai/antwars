#!/usr/bin/env bash
# Runs deploy.sh inside the Cloud Build build of deploy/cloud-run/cloudbuild.yaml,
# from the checkout of the build's commit. It never changes what deploy.sh does:
# the order, gates, checks and rollbacks are deploy.sh's own.
#
# Read from the environment the build config sets:
#   ANTWAR_TAG        the pushed tag that started the build (TAG_NAME): only
#                     deploy-<full sha>, naming the build's own commit, which runs
#                     `deploy.sh all <sha>`
#   ANTWAR_COMMIT     the build's commit (COMMIT_SHA), checked out by the build
#   ANTWAR_ARGS       without a tag only: deploy.sh's arguments, one of
#                     `all <sha>`, `all <sha> --precheck` and
#                     `records-rollback <sha> <sha256:...>`; every other mode
#                     deploys without the idle gates, so none is run
#   ANTWAR_BUILD_ID   the build's id, naming where its outputs are saved
#   ANTWAR_CFG_<NAME> each setting of the private deploy config (config.sh)
#
# In order, before anything changes: the tag or arguments are checked; the
# checked-out commit must be on origin/main, so only reviewed deploy tooling runs
# and a tag on any other commit deploys nothing; the build must run as the
# config's ACCOUNT, read from the metadata server; and the config file is written
# from the settings. deploy.sh then runs with its status file and saved rollback
# spec in a directory of their own (ANTWAR_ROLLBACK_DIR), which is copied
# afterwards to gs://<BUILD_BUCKET>/deploys/<build id>/, and the status is printed
# into the build log. INT and TERM are passed on to deploy.sh, which ends the run
# as FAILED as it does anywhere else. The exit status is deploy.sh's, or 1 when a
# run that succeeded could not have its outputs saved.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/cloud-run/config.sh
source "$HERE/config.sh"

HEX40='^[0-9a-f]{40}$'
[[ "${ANTWAR_COMMIT:-}" =~ $HEX40 ]] || { echo "refusing: the build's commit (COMMIT_SHA) is not a full 40-hex sha" >&2; exit 2; }
# read takes only the first line, so a line break would silently drop the rest
# (`all <sha>` then `--precheck` would deploy): refused before any parsing.
[[ "${ANTWAR_ARGS:-}" != *$'\n'* && "${ANTWAR_ARGS:-}" != *$'\r'* ]] || { echo "refusing: _ARGS holds a line break" >&2; exit 2; }
if [[ -n "${ANTWAR_TAG:-}" ]]; then
  [[ -z "${ANTWAR_ARGS:-}" ]] || { echo "refusing: a tag build takes no _ARGS" >&2; exit 2; }
  [[ "$ANTWAR_TAG" =~ ^deploy-([0-9a-f]{40})$ ]] \
    || { echo "refusing: tag $ANTWAR_TAG is not deploy-<full 40-hex sha>" >&2; exit 2; }
  [[ "${BASH_REMATCH[1]}" == "$ANTWAR_COMMIT" ]] \
    || { echo "refusing: tag $ANTWAR_TAG is on commit $ANTWAR_COMMIT, not the commit it names" >&2; exit 2; }
  ARGS=(all "$ANTWAR_COMMIT")
else
  read -r -a ARGS <<<"${ANTWAR_ARGS:-}"
fi
if ! { [[ ${#ARGS[@]} -eq 2 && "${ARGS[0]}" == all && "${ARGS[1]}" =~ $HEX40 ]] \
  || [[ ${#ARGS[@]} -eq 3 && "${ARGS[0]}" == all && "${ARGS[1]}" =~ $HEX40 && "${ARGS[2]}" == --precheck ]] \
  || [[ ${#ARGS[@]} -eq 3 && "${ARGS[0]}" == records-rollback && "${ARGS[1]}" =~ $HEX40 && "${ARGS[2]}" =~ ^sha256:[0-9a-f]{64}$ ]]; }; then
  echo "refusing: _ARGS must be 'all <sha>', 'all <sha> --precheck' or 'records-rollback <sha> <sha256:digest>', not '${ANTWAR_ARGS:-}'" >&2
  exit 2
fi
[[ "${ANTWAR_BUILD_ID:-}" =~ ^[A-Za-z0-9-]+$ ]] || { echo "refusing: ANTWAR_BUILD_ID is missing or malformed" >&2; exit 2; }

# The config file, one NAME=value line per setting. A value holding a line break
# could add a setting of its own, so it is refused.
CONFIG="$(mktemp)"
OUT="$(mktemp -d)"
trap 'rm -rf "$CONFIG" "$OUT"' EXIT
for NAME in "${DEPLOY_SETTINGS[@]}"; do
  VAR="ANTWAR_CFG_$NAME"
  VALUE="${!VAR:-}"
  [[ "$VALUE" != *$'\n'* && "$VALUE" != *$'\r'* ]] || { echo "refusing: _$NAME holds a line break" >&2; exit 2; }
  printf '%s=%s\n' "$NAME" "$VALUE" >>"$CONFIG"
done
export ANTWAR_DEPLOY_CONFIG="$CONFIG"
load_deploy_config "${DEPLOY_SETTINGS[@]}"

REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
git -C "$REPO_ROOT" fetch --quiet origin main
git -C "$REPO_ROOT" merge-base --is-ancestor HEAD origin/main \
  || { echo "refusing: the checked-out commit $(git -C "$REPO_ROOT" rev-parse HEAD) is not on origin/main" >&2; exit 1; }

IDENTITY="$(curl -sf --max-time 10 -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email || true)"
[[ -n "$IDENTITY" && "$IDENTITY" == "$ACCOUNT" ]] \
  || { echo "refusing: the build runs as ${IDENTITY:-an unreadable identity}, not the config's ACCOUNT" >&2; exit 1; }

# The build image carries git, curl and Node; gcloud comes from Google's signed
# apt repository.
if ! command -v gcloud >/dev/null; then
  echo "+ installing google-cloud-cli" >&2
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    >/etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update -qq >/dev/null
  apt-get install -y -qq google-cloud-cli >/dev/null
fi
# deploy.sh installs the packages its domain comparison needs itself.

set +e
ANTWAR_ROLLBACK_DIR="$OUT" "$HERE/deploy.sh" "${ARGS[@]}" &
CHILD=$!
trap 'kill -INT "$CHILD" 2>/dev/null' INT
trap 'kill -TERM "$CHILD" 2>/dev/null' TERM
wait "$CHILD"
RC=$?
# A signal ends the first wait early; wait again for deploy.sh's own exit.
while kill -0 "$CHILD" 2>/dev/null; do
  wait "$CHILD"
  RC=$?
done
set -e

if [[ -n "$(ls -A "$OUT")" ]]; then
  DEST="gs://$BUILD_BUCKET/deploys/$ANTWAR_BUILD_ID/"
  if CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud storage cp "$OUT"/* "$DEST" \
    --account "$ACCOUNT" --project "$PROJECT" </dev/null >&2; then
    echo "+ deploy outputs saved to $DEST" >&2
  else
    echo "could not save the deploy outputs to $DEST; the status above is the only copy" >&2
    [[ "$RC" != 0 ]] || RC=1
  fi
  if [[ -f "$OUT/antwar-deploy-status" ]]; then
    echo "==================== deploy status ====================" >&2
    cat "$OUT/antwar-deploy-status" >&2
  fi
fi
exit "$RC"
