#!/usr/bin/env bash
# One-time setup for the record service `antwar-records`; run once, by
# hand, before the first `deploy/cloud-run/deploy.sh records <sha>`.
#
#   deploy/cloud-run/record-service-setup.sh
#
# Creates the service's own identity and its private input bucket, and makes the
# only grants it needs. Every gcloud call names the configured --account and
# --project and only sets prompt-disabling variables for itself; the deploy host's gcloud
# configuration is never changed. Everything here is listed, with teardown
# commands, in deploy/cloud-run/TEARDOWN.md.
#
# Its settings come from the private config file named by ANTWAR_DEPLOY_CONFIG
# (deploy/cloud-run/config.sh), the same file deploy.sh reads: ACCOUNT, PROJECT,
# RECORDS_SA (its account id names the identity created), RUN_SA (the slot and
# game servers' identity) and the bare bucket names RECORD_INPUT_BUCKET and
# REPLAY_BUCKET. It stops before any gcloud call, naming each one missing.
set -euo pipefail
# shellcheck source=deploy/cloud-run/config.sh
source "$(dirname "$0")/config.sh"

if [[ $# -ne 0 ]]; then
  echo "usage: $0" >&2
  exit 2
fi

load_deploy_config ACCOUNT PROJECT RECORDS_SA RUN_SA RECORD_INPUT_BUCKET REPLAY_BUCKET
REGION=australia-southeast1
INPUT_BUCKET="gs://$RECORD_INPUT_BUCKET"
REPLAY_BUCKET="gs://$REPLAY_BUCKET"

# Print each gcloud command with its UTC start time before it runs.
stamp() { printf '+ %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
gc() {
  stamp gcloud "$@"
  CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud "$@" --account "$ACCOUNT" --project "$PROJECT" </dev/null
}

# The record service's identity; only the grants below.
gc iam service-accounts create "${RECORDS_SA%%@*}" --display-name "antwar record service"

# Private inputs: uniform access, public access prevented, no soft delete (the
# service deletes an input only after a complete record is confirmed) and no
# lifecycle rule, so failed or unavailable records retain their inputs.
# Retention is unbounded by design: replays and match records are never deleted,
# and inputs are kept until a complete record is confirmed, so a failed or
# unavailable record can be rebuilt from them. Storage cost and match-history
# listing time grow with match volume; this is accepted for now and is to be
# revisited after open-sourcing.
gc storage buckets create "$INPUT_BUCKET" --location "$REGION" \
  --uniform-bucket-level-access --public-access-prevention --soft-delete-duration 0
gc storage buckets update "$INPUT_BUCKET" --update-labels app=antwar

# A new service account takes a short while to resolve after it is created, and a
# grant to it before then fails as "does not exist", stopping the setup with the
# remaining grants unmade. Wait for it, bounded, before any grant.
RECORDS_SA_WAIT=120
deadline=$((SECONDS + RECORDS_SA_WAIT))
until gc iam service-accounts describe "$RECORDS_SA" >/dev/null; do
  if ((SECONDS >= deadline)); then
    echo "record service account $RECORDS_SA did not resolve within ${RECORDS_SA_WAIT}s; stopping before any grant" >&2
    exit 1
  fi
  sleep 5
done

# The game server only creates inputs: no read, overwrite or delete.
gc storage buckets add-iam-policy-binding "$INPUT_BUCKET" --member "serviceAccount:$RUN_SA" --role roles/storage.objectCreator
# The slot server reads back handover saves, and nothing else:
# object reads only under handover/. Listing is checked on the bucket, which the
# condition never matches, so it lists nothing.
# Existing deployments need this grant applied separately by an authorized human;
# do not rerun this one-time resource-creation script to migrate their IAM.
gc storage buckets add-iam-policy-binding "$INPUT_BUCKET" --member "serviceAccount:$RUN_SA" --role roles/storage.objectViewer \
  --condition "expression=resource.name.startsWith(\"projects/_/buckets/${INPUT_BUCKET#gs://}/objects/handover/\"),title=antwar-run-handover-saves-read"
# The record service lists, reads, writes its failure markers in, and deletes inputs.
gc storage buckets add-iam-policy-binding "$INPUT_BUCKET" --member "serviceAccount:$RECORDS_SA" --role roles/storage.objectUser
# Record-only generation-checked rebuilds need get/create/delete on existing
# unavailable objects, public and sealed private alike. GCS replacement requires
# delete permission; the service never sends a record delete or changes binaries.
# Existing deployments need this grant applied separately by an authorized human;
# do not rerun this one-time resource-creation script to migrate their IAM.
gc storage buckets add-iam-policy-binding "$REPLAY_BUCKET" --member "serviceAccount:$RECORDS_SA" --role roles/storage.objectUser
# The private-record key, to seal private lobbies' records.
gc secrets add-iam-policy-binding antwar-private-replay-key --member "serviceAccount:$RECORDS_SA" --role roles/secretmanager.secretAccessor

stamp done record service setup
