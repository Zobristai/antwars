# shellcheck shell=bash
# The private deploy settings, sourced by deploy.sh, record-service-setup.sh and
# domain.sh. The operator keeps one file of NAME=value lines outside any checkout
# and names it in ANTWAR_DEPLOY_CONFIG; deploy/cloud-run/deploy.env.example lists
# every name. Nothing here has a default, and the file is read, never sourced:
# a value is the literal text after the first `=`. Blank lines and lines
# starting with `#` are skipped.
#
#   ACCOUNT              the gcloud account every call names (--account)
#   PROJECT              the Google Cloud project every call names (--project),
#                        and the shared store's project (GCLOUD_PROJECT)
#   BUILD_BUCKET         Cloud Build's source and log bucket, without gs://
#   BUILD_SA             Cloud Build's service account email
#   RUN_SA               the game and slot servers' service account email
#   RECORDS_SA           the record service's service account email
#   RECORD_INPUT_BUCKET  the record service's private input bucket, without gs://
#   REPLAY_BUCKET        the replay bucket, without gs://
#   GAME_SERVICE_URL     the game service's own https://...run.app address, which
#                        the post-deploy domain comparison checks against
#                        https://antwars.ai

DEPLOY_SETTINGS=(ACCOUNT PROJECT BUILD_BUCKET BUILD_SA RUN_SA RECORDS_SA RECORD_INPUT_BUCKET REPLAY_BUCKET GAME_SERVICE_URL)

# Sets each named setting from the file, and only those. Every setting is first
# unset, so the calling environment can never supply one. Exits 1, naming each
# named setting, when ANTWAR_DEPLOY_CONFIG is unset or its file is missing or
# unreadable; naming each one missing when the file lacks some.
load_deploy_config() {
  local file="${ANTWAR_DEPLOY_CONFIG:-}" line key wanted missing=()
  unset "${DEPLOY_SETTINGS[@]}"
  if [[ -z "$file" ]]; then
    echo "refusing: ANTWAR_DEPLOY_CONFIG is not set; it names the private deploy config file, which must set $*" >&2
    exit 1
  fi
  if [[ ! -f "$file" || ! -r "$file" ]]; then
    echo "refusing: the deploy config file $file is missing or unreadable; it must set $*" >&2
    exit 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*(#|$) || "$line" != *=* ]]; then continue; fi
    key="${line%%=*}"
    for wanted in "$@"; do
      if [[ "$key" == "$wanted" ]]; then printf -v "$key" '%s' "${line#*=}"; fi
    done
  done <"$file"
  for wanted in "$@"; do
    [[ -n "${!wanted:-}" ]] || missing+=("$wanted")
  done
  if [[ ${#missing[@]} -ne 0 ]]; then
    echo "refusing: the deploy config file $file lacks ${missing[*]}" >&2
    exit 1
  fi
}
