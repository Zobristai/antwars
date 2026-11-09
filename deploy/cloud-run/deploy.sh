#!/usr/bin/env bash
# Build one named main commit of antwar in Google Cloud and deploy it to the
# Cloud Run service `antwar`.
#
#   deploy/cloud-run/deploy.sh <full 40-hex commit sha on main>
#
# The image is built by Cloud Build from the commit's own Dockerfile (a
# `git archive` of exactly that commit, never the working tree), tagged with the
# sha, and deployed with the whole service shape restated, so every redeploy
# reasserts it. Every gcloud call names the configured --account and --project
# and only sets prompt-disabling variables for itself; the deploy host's gcloud
# configuration is never changed. The resources it uses are created once and
# listed, with teardown commands, in deploy/cloud-run/TEARDOWN.md.
#
# Settings. The account, project, buckets, service accounts and game service
# address come from the private config file named by ANTWAR_DEPLOY_CONFIG
# (deploy/cloud-run/config.sh; deploy.env.example lists the names). Each mode
# reads only the settings it needs once its arguments are checked, before any
# git, gcloud or curl call, and stops naming every one that is missing. Nothing
# has a default. The game, slot and preview services get the project as
# GCLOUD_PROJECT, their shared store's project.
#
# A preview mode (below) deploys any pushed commit to the separate service
# `antwar-preview` instead; it never touches `antwar`. A slots mode (below)
# deploys the lobby match-slot services; it never touches `antwar` either.
set -euo pipefail
# shellcheck source=deploy/cloud-run/config.sh
source "$(dirname "$0")/config.sh"

# Preview mode. Runs only when the first argument is
# exactly `preview` or `preview-remove`, and always exits; any other call takes
# the main-only path below, unchanged.
#
#   deploy/cloud-run/deploy.sh preview <full 40-hex sha pushed to origin> <name> [<rules> <players>]
#   deploy/cloud-run/deploy.sh preview-remove <name>
#
# `preview` builds the commit exactly as the main path does, into image
# antwar/preview:<sha> (so the live service's server:<sha> tags are never moved),
# deploys it to the separate Cloud Run service `antwar-preview` with traffic tag
# <name>, and prints the tag's address. `preview-remove` deletes that tag; the
# revision stays until the service is deleted (TEARDOWN.md). Neither ever names
# service `antwar`.
#
# Comparison runs: <rules> (v4, count-marks or redesign) and <players>
# (2 or 4) set ANTWAR_RULES and ANTWAR_PLAYERS on the new revision; without them
# both are removed, so no revision inherits a previous one's comparison settings.
# An image already built for the sha is reused by digest, and every revision is
# deployed by digest, so all comparison revisions run the same image.
#
# Slots mode. Lobby matches play on match-slot servers, one Cloud Run
# service per slot at most one instance, so a slot's address reaches the one
# instance playing it; every slot service shares the default Firestore database
# under one namespace. Cloud Run can briefly exceed that maximum: an
# extra instance of the same revision defers to the slot's live owner, and its
# HTTP startup probe on /ready fails until it holds the slot, so Cloud Run routes
# it no request. The probe retries every second for at most 600 s (Cloud Run's
# cap), after which Cloud Run shuts the waiting instance down. A slot service keeps no instance running while
# idle: its server is woken at ANTWAR_SLOT_URL_TEMPLATE when a lobby is
# assigned its slot, and stops only once idle. Runs only when the first argument
# is exactly `slots` or `slots-remove`, and always exits.
#
#   deploy/cloud-run/deploy.sh slots preview <full 40-hex sha pushed to origin> [<public> <private>]
#   deploy/cloud-run/deploy.sh slots live <full 40-hex sha on main>
#   deploy/cloud-run/deploy.sh slots-remove preview
#
# `slots preview` takes any commit on an origin branch (the preview provenance
# check), image antwar/preview:<sha>, namespace `preview`, and <public> public and
# <private> private slots (default 1 and 1, for the capacity measurement more);
# services antwar-preview-public-<n> and antwar-preview-private-<n>. Preview slot
# services beyond the requested counts are deleted, so every running slot server
# agrees on the slot set. Preview has no replay bucket: its matches never enter
# the live recordings' public history.
# `slots live` is the live declaration: main commits only (the live path's
# check), image antwar/server:<sha>, namespace `live`, 8 public and 8 private
# slots (superseding the one-and-one launch shape),
# services antwar-public-0 to antwar-public-7 and antwar-private-0 to
# antwar-private-7, with the replay bucket. The live path below gives the root
# service `antwar` the same counts and template, so its slot allocator hands out
# exactly these slots; deploy `slots live` at a commit before `antwar` at it.
# Live deploys are scheduled separately; the records and slot setup modes run none.
# `slots-remove preview` deletes every preview slot service.
#
# Records mode. The record service builds every finished match's
# readable record from the inputs the game server leaves in the private input
# bucket. It is its own Cloud Run service, `antwar-records`, with its own
# identity, `antwar-records`; it never deploys or names a game-server service.
# Runs only when the first argument is exactly `records` or `records-rollback`
# (below), and always exits.
#
#   deploy/cloud-run/deploy.sh records <full 40-hex commit sha on main>
#
# Main commits only (the live path's check), image antwar/server:<sha> started as
# `npm run record-service`, and ANTWAR_CODE_VERSION=<sha>, so the service only
# builds records for matches played by the same commit. Its bucket, identity and
# grants are created once by record-service-setup.sh (TEARDOWN.md).

# Rollback tags. Cloud Run keeps a minimum instance warm for every
# revision that serves traffic or carries a tag, and an old records revision
# kept warm races the new one for the same match inputs. So `records` reads the
# revision serving antwar-records before it builds anything, saves that
# revision's full spec to ${ANTWAR_ROLLBACK_DIR:-$HOME}/records-rollback-<revision>.json,
# and after its deploy moves all traffic to the new revision, by name, and clears
# every tag. Its rollback path is the outgoing image digest, printed on stdout as a
# `records-rollback` command: that mode deploys antwar-records exactly as
# `records` does, but from the given image digest and code version, once that
# digest is the one tagged <repo>:<sha>, the image built from that commit.
#
#   deploy/cloud-run/deploy.sh records-rollback <full 40-hex commit sha on main> <sha256:... image digest>
#
# The live path likewise reads the revision serving `antwar` before it builds,
# and after its deploy replaces every tag on `antwar` with the one rollback tag
# r<first 8 of its commit> on that outgoing revision; its traffic moves to the
# new revision by name (deploy_named). Both stop with the offending revisions
# named if any other tag (or, for records, any other traffic) remains. Neither
# ever deletes a revision.

# All mode. Brings antwar-records, antwar-public-0..7,
# antwar-private-0..7 and antwar to one main commit from one image (server:<sha>,
# reused or built, deployed by digest), in that order, and prints each service's
# new revision. Runs only when the first argument is exactly `all`, and always exits.
#
#   deploy/cloud-run/deploy.sh all <full 40-hex commit sha on main> [--precheck]
#
# With --precheck it runs only the checks below that precede any change, the
# commit on main and every service's preflight, and changes nothing: no build,
# deploy, traffic move, run mark, status file or saved spec. It names every
# blocker, exits 1 when anything blocks, and otherwise prints clear and exits 0.
#
# Before anything changes, every service must serve exactly one revision at 100%,
# its latest created one, with a readable image digest and ANTWAR_CODE_VERSION;
# that revision becomes its one rollback. The one exception is a failed attempt's
# leftover: a latest created revision that serves nothing, carries no tag and is
# recorded in a run mark (below) is let through and never given traffic. Any
# other latest created revision that does not serve stops the run, named. Gates read the live namespace in
# Firestore (the bearer goes to curl on stdin) and count any unreadable answer as
# busy. The global gate needs no waiting queue entry (queueWaiting/*.entries) and
# no lobby that is neither stored `ended` nor expired. Expiry is the
# src/lobby/lobbies.ts isExpired rule, derived from the clock and never written: a
# player-created lobby (no `mode`) stored `open` or `waiting`, at or after 12
# hours from its createdAt, or 15 minutes for a house challenge lobby (`challengeId`).
# Queue entries expire on the server (12 hours, 15 minutes for house-* modes); this
# gate counts any listed waiting entry busy. Holding and queue-made lobbies never expire, so they
# wait until ended; a lobby with no readable createdAt counts as busy. A slot
# also needs slots/<slot> absent, /live/status idle, and slots/<slot> still absent after that. Records and
# the game wait on the global gate; slots are taken in rounds, busy ones retried a
# minute later. After ${ANTWAR_DEPLOY_ROUNDS:-120} rounds the run stops, naming
# whatever is still busy.
#
# Records and each slot are swapped the same way: the deploy creates the new
# revision with --no-traffic, the run marks it, and once it is Ready all traffic
# moves to it by name. No traffic move ever names "latest". Public slots also carry
# ANTWAR_OPERATOR_TOKEN from Secret Manager. A slot counts as swapped only after
# its traffic is all on the new revision and then, on ${ANTWAR_SWAP_STABLE:-3}
# consecutive probes ${ANTWAR_SWAP_INTERVAL:-5} s apart, its instance record
# (instances/<slot>) names the new revision, /ready answers 200 and, on a public
# slot, an unauthenticated POST /operator/stop answers 401: an instance of the
# outgoing revision can take the slot back mid-swap. Without that run
# within ${ANTWAR_SWAP_PROBES:-24} probes the deploy stops before the next slot.
# The game is deployed with --no-traffic at 2 vCPU
# with ANTWAR_PRIVATE_REPLAY_KEY. Traffic moves to it once it is Ready, and
# returns to the outgoing revision unless https://antwars.ai/ answers 200 within
# five minutes. The game keeps one rollback tag r<first 8 of its commit> on the
# outgoing revision. Records and each slot keep that revision
# untagged, so no instance of it starts: records with its records-rollback command
# printed, each slot with a gcloud command that restores the outgoing revision by
# name (--to-revisions <revision>=100). Every other tag is removed, and the run
# stops naming any service left with another tag; no revision is deleted.
# The run reports done only if all 18 services serve their latest ready revision
# at ANTWAR_CODE_VERSION=<sha>; otherwise it names each one that does not.
# Before any change it installs the checkout's packages (npm ci, no package
# script), which that comparison needs.
# After printing the new revisions it runs the domain comparison between
# https://antwars.ai and GAME_SERVICE_URL (probe.mjs domain, about 12 minutes),
# and reports passed or SKIPPED (no public lobby in both catalogs; never a pass).
# A failed comparison stops the run non-zero with nothing rolled back.
#
# First deploy. Only when gcloud reports every one of the 18 services absent
# (Cannot find service), --precheck and the run take the first-deploy path: no
# preflight, rolling-support check, global or slot gate, or rollback (there is no
# outgoing revision). Each service is created whole, with this commit's image and
# the deploy flags it always takes, by a create-only request that refuses an
# existing service (create_service); on a refusal the run stops, the project no
# longer empty, with nothing deployed to that service and none of its traffic
# moved. It goes on only on the revision its own create named. The swap checks
# and the site-200 check after the game are kept; on its failure the run
# stops with nothing reverted. Only the final domain comparison is skipped, and
# the run says so. A project with any service present, or any service that
# cannot be read, takes every check above unchanged.
#
# Rolling deploy. When every outgoing service's ANTWAR_CODE_VERSION
# contains both 46d6c91 (running/<commit> records overlap signal) and
# e6f22591 (withheld/<slot> mark), no service waits on the global gate:
# a queued player or a lobby elsewhere never holds the run, and queue entries and
# lobbies are left in place. A service whose commit the checkout cannot show to
# contain them (a checkout without that history) still counts when its image,
# at the server repository by digest, carries the label
# ai.antwars.rolling-support=1 that every build from the Dockerfile with rolling support
# carries; the label is read from the registry over https only, with the
# access token sent only to the registry's own host. Otherwise (support not
# established) the run is the full-gate run above, unchanged, and names the
# service and the reason.
#   - Records: running/<outgoing commit> and running/<new commit> are written to
#     the input bucket and the outgoing revision gets the tag r<first 8 of its
#     commit>, which keeps its builder running, before records is swapped. Each
#     builder then builds only its own build's matches (src/records/main.ts).
#     (When the outgoing records commit is the new one there is no overlap: the
#     swap is as above.)
#   - Slots: every slot is withheld from new matches (withheld/<slot>), then each
#     is swapped once slots/<slot> is absent, /live/status idle and slots/<slot>
#     still absent, and released (its mark deleted) after its checks and rollback.
#     A busy slot is retried a minute later; its match plays to the end first.
#   - Game: swapped as above, without waiting.
#   - Records drain: the inputs present once every slot is swapped are waited on
#     until each is gone or carries failed-<outgoing or new commit>-3 (its builder
#     has given up). Then the records tag is cleared (its rollback as above) and
#     running/<outgoing commit> removed; running/<new commit> is removed last,
#     after the final check, so a still-stopping old builder never takes new
#     inputs. The drain stops after the same round limit.
# On any stop, every mark the run set is cleared except a slot whose swap was in
# progress; any mark left, and any records overlap still active, is named on
# stderr with the commands that clear it.
#
# Run marks. Every revision the run creates is recorded the moment it exists, by
# an empty object running/<sha>/<run>/<revision> in the record input bucket (the
# run is <UTC start>-<first 8 of sha>); they are never removed by the run. Only
# the bucket's marks are read.
#
# Traffic, in every mode but preview. Each deploy goes through deploy_named:
# the new revision is created with no traffic, named, and given all traffic by
# that name once Ready. No traffic move follows "latest", so a failed or no-op
# deploy never routes to an older attempt's leftover revision.
#
# Status. One fixed file, ${ANTWAR_ROLLBACK_DIR:-$HOME}/antwar-deploy-status,
# holds the outcome of the last run: RUNNING from its start, then DONE, or FAILED
# with the step, the slot, the reason and the revision every service is left
# serving, on any non-zero exit, INT or TERM included (a FAILED banner repeats it
# on stderr). A run killed outright leaves RUNNING. Whoever runs the deploy reads
# this file at the end of every run.

# The live slot set, one value for both the live
# slot services and the root service's slot allocator.
LIVE_PUBLIC_SLOTS=8
LIVE_PRIVATE_SLOTS=8

# Helpers, for both the records mode and the live path; REGION is set
# by each before use.
# Prints the one revision of service $1 serving traffic.
serving_revision() {
  CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run services describe "$1" \
    --account "$ACCOUNT" --project "$PROJECT" \
    --region "$REGION" \
    --format json </dev/null \
    | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const serving = (JSON.parse(s).status?.traffic ?? []).filter((t) => (t.percent ?? 0) > 0);
        if (serving.length !== 1 || !serving[0].revisionName) process.exit(1);
        console.log(serving[0].revisionName);
      });'
}

# Prints the value of ANTWAR_LOAD_BALANCER_ADDRESS for the entry service `antwar`:
# every address of the antwars.ai global forwarding rules (domain.sh's antwar-domain-
# rules), IPv4 and IPv6, deduplicated, sorted and comma-separated, the list
# src/server/clientSource.ts loadBalancerAddressesFromEnv reads. The family is read from
# each address itself. Refuses, naming the variable and never an address, when the
# list cannot be read, is empty, or holds an entry that is not an unscoped IPv4 or
# IPv6 address (the server would refuse to start on it). Read-only.
load_balancer_addresses() {
  CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud compute forwarding-rules list --global \
    --account "$ACCOUNT" --project "$PROJECT" \
    --filter 'name~^antwar-domain-' \
    --format json </dev/null \
    | node -e '
      const { isIP } = require("node:net");
      const refuse = (why) => { console.error(`refusing: ANTWAR_LOAD_BALANCER_ADDRESS ${why}`); process.exit(1); };
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        let rules;
        try { rules = JSON.parse(s); } catch { refuse("cannot be read: the forwarding-rule list is not JSON"); }
        if (!Array.isArray(rules)) refuse("cannot be read: the forwarding-rule list is not a list");
        rules = rules.filter((r) => typeof r?.name === "string" && r.name.startsWith("antwar-domain-"));
        if (rules.length === 0) refuse("resolves empty: no antwar-domain- global forwarding rule");
        const addresses = new Set();
        for (const r of rules) {
          const a = typeof r.IPAddress === "string" ? r.IPAddress.trim() : "";
          if (a.includes("%") || isIP(a) === 0) refuse(`resolves invalid: forwarding rule ${r.name} has no unscoped IPv4 or IPv6 address`);
          addresses.add(a);
        }
        console.log([...addresses].sort().join(","));
      });'
}

# Writes revision $1's full spec as JSON to file $2, and prints its image digest
# (<repo>@sha256:...) and its ANTWAR_CODE_VERSION, space-separated.
revision_facts() {
  CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run revisions describe "$1" \
    --account "$ACCOUNT" --project "$PROJECT" \
    --region "$REGION" \
    --format json </dev/null >"$2"
  node -e '
    const rev = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const digest = rev.status?.imageDigest ?? "";
    const env = rev.spec?.containers?.[0]?.env ?? [];
    const sha = env.find((e) => e.name === "ANTWAR_CODE_VERSION")?.value ?? "";
    if (!/@sha256:[0-9a-f]{64}$/.test(digest) || !/^[0-9a-f]{40}$/.test(sha)) process.exit(1);
    console.log(digest + " " + sha);' "$2"
}

# Stops unless, on service $1, no tag remains except tag $3 on revision $2 (both
# empty: no tag at all) and, when $4 is `latest-only`, only the latest ready
# revision serves traffic, at 100%. Names every offending revision.
check_tags_and_traffic() {
  CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run services describe "$1" \
    --account "$ACCOUNT" --project "$PROJECT" \
    --region "$REGION" \
    --format json </dev/null \
    | KEEP_REV="$2" KEEP_TAG="$3" TRAFFIC="$4" SERVICE="$1" node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const svc = JSON.parse(s);
        const latest = svc.status?.latestReadyRevisionName;
        const bad = [];
        let latestPercent = 0;
        for (const t of svc.status?.traffic ?? []) {
          if (t.tag && !(t.tag === process.env.KEEP_TAG && t.revisionName === process.env.KEEP_REV)) bad.push(`tag ${t.tag} on ${t.revisionName}`);
          if (process.env.TRAFFIC !== "latest-only" || !((t.percent ?? 0) > 0)) continue;
          if (t.revisionName === latest) latestPercent += t.percent;
          else bad.push(`traffic ${t.percent}% on ${t.revisionName}`);
        }
        if (process.env.TRAFFIC === "latest-only" && latestPercent !== 100) bad.push(`latest revision ${latest} serves ${latestPercent}%`);
        for (const b of bad) console.error(`${process.env.SERVICE}: unexpected ${b}`);
        process.exit(bad.length ? 1 : 0);
      });'
}

# Every gcloud call these helpers make, with the account, project and region last.
run_gcloud() {
  CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud "$@" \
    --account "$ACCOUNT" --project "$PROJECT" \
    --region "$REGION" </dev/null
}
# Prints service $1's one revision serving 100% (NONE otherwise), its latest
# created and its latest ready revision, and whether the latest created one
# has neither traffic nor a tag (clear) or has either (routed).
service_state() {
  run_gcloud run services describe "$1" --format json \
    | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const st = JSON.parse(s).status ?? {};
        const serving = (st.traffic ?? []).filter((t) => (t.percent ?? 0) > 0);
        const one = serving.length === 1 && serving[0].percent === 100 && serving[0].revisionName ? serving[0].revisionName : "NONE";
        const created = st.latestCreatedRevisionName || "NONE";
        const routed = (st.traffic ?? []).some((t) => (t.revisionName === created || (t.latestRevision && st.latestReadyRevisionName === created))
          && ((t.percent ?? 0) > 0 || t.tag));
        console.log([one, created, st.latestReadyRevisionName || "NONE", routed ? "routed" : "clear"].join(" "));
      });'
}

# Prints revision $1's ANTWAR_CODE_VERSION, CPU limit, and whether it carries
# ANTWAR_PRIVATE_REPLAY_KEY and ANTWAR_OPERATOR_TOKEN, and whether it is Ready.
revision_shape() {
  run_gcloud run revisions describe "$1" --format json \
    | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const rev = JSON.parse(s);
        const c = rev.spec?.containers?.[0] ?? {};
        const env = c.env ?? [];
        const has = (name) => env.some((e) => e.name === name);
        const ready = (rev.status?.conditions ?? []).find((x) => x.type === "Ready")?.status === "True";
        console.log([env.find((e) => e.name === "ANTWAR_CODE_VERSION")?.value || "-", c.resources?.limits?.cpu || "-",
          has("ANTWAR_PRIVATE_REPLAY_KEY") ? "key" : "nokey", has("ANTWAR_OPERATOR_TOKEN") ? "token" : "notoken",
          ready ? "ready" : "notready"].join(" "));
      });'
}

# Prints service_state for service $1, or ABSENT when gcloud reports that the
# service does not exist; fails, repeating gcloud's error, when it cannot be read.
service_state_or_absent() {
  local err out
  err="$(mktemp)"
  if out="$(service_state "$1" 2>"$err")"; then
    rm -f "$err"
    echo "$out"
  elif grep -qi 'cannot find service' "$err"; then
    rm -f "$err"
    echo ABSENT
  else
    cat "$err" >&2
    rm -f "$err"
    return 1
  fi
}

# The one way every mode deploys a service and moves its traffic: by
# the name of the revision this deploy created, never to "latest", so a failed
# or no-op deploy can never send traffic to an older run's leftover revision.
#
#   deploy_named <service> <gcloud run deploy flags...>
#
# The deploy passes --no-traffic (unless it creates the service, which gcloud
# refuses with --no-traffic). The revision it created is the service's latest
# created one, which must differ from the latest created before the deploy;
# on_created is called with it at once, even when the deploy then fails. Once it
# is Ready, all traffic moves to it with --to-revisions <it>=100, and it must
# then serve exactly 100%. Sets CREATED_NEW. Every failure goes to deploy_stop
# with the service's traffic left on the revision it served before.
deploy_named() {
  local svc="$1" before serving created state deployed=0 flags=(--no-traffic)
  shift
  read -r serving before _ _ < <(service_state_or_absent "$svc") \
    || deploy_stop "cannot read $svc before its deploy"
  if [[ "$serving" == ABSENT ]]; then
    before=""
    serving=none
    flags=()
  fi
  run_gcloud run deploy "$svc" "$@" ${flags[@]+"${flags[@]}"} && deployed=1
  read -r _ created _ _ < <(service_state "$svc") || true
  CREATED_NEW=""
  if [[ -z "$created" || "$created" == NONE || "$created" == "$before" ]]; then
    [[ "$deployed" == 0 ]] || deploy_stop "$svc has no new revision after its deploy (latest created ${created:-unreadable}); its traffic stays on $serving"
    deploy_stop "deploying $svc failed, creating no new revision; its traffic stays on $serving"
  fi
  on_created "$svc" "$created"
  [[ "$deployed" == 1 ]] || deploy_stop "deploying $svc failed; its new revision $created gets no traffic, which stays on $serving"
  read -r _ _ _ _ state < <(revision_shape "$created") || true
  [[ "$state" == ready ]] || deploy_stop "$svc $created is not Ready; its traffic stays on $serving"
  stamp gcloud run services update-traffic "$svc" --to-revisions "$created=100" ...
  run_gcloud run services update-traffic "$svc" --to-revisions "$created=100" || deploy_stop "moving $svc traffic to $created failed"
  read -r serving _ _ _ < <(service_state "$svc") || true
  [[ "$serving" == "$created" ]] || deploy_stop "$svc serves ${serving:-nothing readable} at 100%, not its new revision $created, after its traffic move"
  CREATED_NEW="$created"
}
# deploy_named's defaults; `all` replaces both (its stop, and its run mark).
deploy_stop() { echo "stopping: $*" >&2; exit 1; }
on_created() { :; }

if [[ "${1:-}" == preview || "${1:-}" == preview-remove || "${1:-}" == slots || "${1:-}" == slots-remove || "${1:-}" == records || "${1:-}" == records-rollback || "${1:-}" == all ]]; then
  MODE="$1"
  # Same values as the main path below.
  REGION=australia-southeast1
  MEMORY=2Gi
  PREVIEW_SERVICE=antwar-preview
  RECORDS_SERVICE=antwar-records
  stamp() { printf '+ %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
  # A tag is one DNS label inside the tag address; 20 characters keeps it short.
  valid_name() { [[ "$1" =~ ^[a-z]([a-z0-9-]{0,18}[a-z0-9])?$ ]]; }

  # Reads the named settings (config.sh), then finds the checkout. Each mode calls
  # it once its arguments are checked, before any git, gcloud or curl call.
  settings() {
    load_deploy_config "$@"
    [[ -z "${BUILD_BUCKET:-}" ]] || BUCKET="gs://$BUILD_BUCKET"
    REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
  }

  # The preview provenance check: refuses only a commit on no origin branch.
  require_origin_commit() {
    git -C "$REPO_ROOT" fetch --quiet origin '+refs/heads/*:refs/remotes/origin/*'
    if ! git -C "$REPO_ROOT" cat-file -e "$1^{commit}" 2>/dev/null \
      || [[ -z "$(git -C "$REPO_ROOT" for-each-ref --contains "$1" refs/remotes/origin)" ]]; then
      echo "refusing: $1 is not a commit on any origin branch" >&2
      exit 1
    fi
  }

  # Sets DIGEST to the image <repo>:<sha>, building it from the commit only when
  # no image for the sha exists yet.
  image_digest() {
    local repo="$1" sha="$2"
    local image="$repo:$sha"
    digest_of() {
      CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud artifacts docker images describe "$image" \
        --account "$ACCOUNT" --project "$PROJECT" \
        --format 'value(image_summary.digest)' </dev/null 2>/dev/null
    }
    DIGEST="$(digest_of || true)"
    if [[ -n "$DIGEST" ]]; then
      stamp reusing "$image" "$DIGEST"
    else
      WORK="$(mktemp -d)"
      # `all` keeps its own exit handler, which also removes WORK.
      [[ "$MODE" == all ]] || trap 'rm -rf "$WORK"' EXIT
      git -C "$REPO_ROOT" archive --format=tar.gz -o "$WORK/source.tgz" "$sha"

      stamp gcloud builds submit "$WORK/source.tgz" --tag "$image" ...
      CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud builds submit "$WORK/source.tgz" \
        --account "$ACCOUNT" --project "$PROJECT" \
        --region "$REGION" \
        --tag "$image" \
        --service-account "projects/$PROJECT/serviceAccounts/$BUILD_SA" \
        --gcs-source-staging-dir "$BUCKET/source" \
        --gcs-log-dir "$BUCKET/logs" </dev/null
      DIGEST="$(digest_of)" || { echo "built $image, but could not read its digest" >&2; exit 1; }
    fi
    [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "unexpected digest for $image: $DIGEST" >&2; exit 1; }
  }

  # Preview slot services carry label antwar-slots=preview; deletes every one not
  # named in the arguments.
  prune_preview_slots() {
    local keep=" $* " names name
    stamp gcloud run services list --filter metadata.labels.antwar-slots=preview ...
    names="$(CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run services list \
      --account "$ACCOUNT" --project "$PROJECT" \
      --region "$REGION" \
      --filter 'metadata.labels.antwar-slots=preview' \
      --format 'value(metadata.name)' </dev/null)"
    for name in $names; do
      [[ "$keep" == *" $name "* ]] && continue
      [[ "$name" =~ ^antwar-preview-(public|private)-[0-9]+$ ]] || { echo "refusing to delete unexpected service $name" >&2; exit 1; }
      stamp gcloud run services delete "$name" ...
      CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run services delete "$name" \
        --account "$ACCOUNT" --project "$PROJECT" \
        --region "$REGION" </dev/null
    done
  }

  # The live path's check: refuses a commit not on origin/main.
  require_main_commit() {
    git -C "$REPO_ROOT" fetch --quiet origin main
    if ! git -C "$REPO_ROOT" merge-base --is-ancestor "$1" origin/main; then
      echo "refusing: $1 is not a commit on origin/main" >&2
      exit 1
    fi
  }

  # Sets PROJECT_NUMBER. A slot server registers its own address in the store,
  # so it must know it before it boots: Cloud Run's deterministic service URL.
  project_number() {
    stamp gcloud projects describe "$PROJECT" ...
    PROJECT_NUMBER="$(CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud projects describe "$PROJECT" \
      --account "$ACCOUNT" \
      --format 'value(projectNumber)' </dev/null)"
    [[ "$PROJECT_NUMBER" =~ ^[0-9]+$ ]] || { echo "unexpected project number: $PROJECT_NUMBER" >&2; exit 1; }
  }

  # The live slot declaration at commit $1 (`slots live` and `all`).
  live_slot_settings() {
    REPO="$REGION-docker.pkg.dev/$PROJECT/antwar/server"
    PREFIX=antwar-
    NAMESPACE=live
    PUBLIC_SLOTS="$LIVE_PUBLIC_SLOTS"
    PRIVATE_SLOTS="$LIVE_PRIVATE_SLOTS"
    # Recorded matches are handed to the record service at this commit; username
    # claims are counted per client source (src/accounts/caller.ts).
    EXTRA_ENV=",ANTWAR_REPLAY_BUCKET=$REPLAY_BUCKET,ANTWAR_RECORD_INPUT_BUCKET=$RECORD_INPUT_BUCKET,ANTWAR_CODE_VERSION=$1,ANTWAR_USERNAME_CLAIM_LIMIT_RULE=client"
  }

  # Sets RECORDS_FLAGS, the record service's whole shape at commit $1. The
  # --set-env-vars and --set-secrets flags replace every variable and secret.
  # Exactly one instance with CPU always allocated, because the service sweeps
  # in the background and serves no traffic but its health check. Ingress is
  # internal only. NODE_OPTIONS caps the V8 heap of the service and of its
  # history worker, so a worker over the cap fails that one build instead of
  # the container being killed.
  records_flags() {
    RECORDS_FLAGS=(
      --command npm --args run,record-service
      --set-env-vars "ANTWAR_RECORD_INPUT_BUCKET=$RECORD_INPUT_BUCKET,ANTWAR_REPLAY_BUCKET=$REPLAY_BUCKET,ANTWAR_CODE_VERSION=$1,NODE_OPTIONS=--max-old-space-size=512"
      --set-secrets "ANTWAR_PRIVATE_REPLAY_KEY=antwar-private-replay-key:1"
      --service-account "$RECORDS_SA"
      --min-instances 1 --max-instances 1
      --no-cpu-throttling
      --cpu 1 --memory "$MEMORY"
      --ingress internal
      --invoker-iam-check
      --labels "app=antwar,commit=$1"
    )
  }

  # Sets SLOT_FLAGS, slot $1's whole shape at address $2 with secrets $3. It
  # reads PROJECT, NAMESPACE, PUBLIC_SLOTS, PRIVATE_SLOTS, TEMPLATE, EXTRA_ENV and SHA.
  # The --set-env-vars and --set-secrets flags replace every variable and
  # secret. At most one instance, and none kept running while idle: the server
  # is woken when its slot is assigned. No request reaches an instance
  # before /ready answers 200, which happens once it holds the slot.
  # The server runs as antwar-run through the metadata server; there is no key
  # file.
  slot_flags() {
    SLOT_FLAGS=(
      --set-env-vars "ANTWAR_SLOT=$1,ANTWAR_PUBLIC_URL=$2,ANTWAR_STORE_NAMESPACE=$NAMESPACE,GCLOUD_PROJECT=$PROJECT,ANTWAR_PUBLIC_SLOTS=$PUBLIC_SLOTS,ANTWAR_PRIVATE_SLOTS=$PRIVATE_SLOTS,ANTWAR_SLOT_URL_TEMPLATE=$TEMPLATE$EXTRA_ENV"
      --set-secrets "$3"
      --service-account "$RUN_SA"
      --min-instances 0 --max-instances 1
      --no-cpu-throttling
      --cpu 1 --memory "$MEMORY"
      --timeout 3600
      --concurrency 1000
      --startup-probe "httpGet.path=/ready,periodSeconds=1,failureThreshold=600,timeoutSeconds=1"
      --ingress all
      --no-invoker-iam-check
      --labels "app=antwar,commit=$SHA,antwar-slots=$NAMESPACE"
    )
  }

  if [[ "$MODE" == all ]]; then
    SHA="${2:-}"
    ROUNDS="${ANTWAR_DEPLOY_ROUNDS:-120}"
    SWAP_STABLE="${ANTWAR_SWAP_STABLE:-3}"
    SWAP_PROBES="${ANTWAR_SWAP_PROBES:-24}"
    SWAP_INTERVAL="${ANTWAR_SWAP_INTERVAL:-5}"
    PRECHECK=0
    [[ $# -ne 3 || "$3" != --precheck ]] || PRECHECK=1
    if [[ ( $# -ne 2 && "$PRECHECK" != 1 ) || ! "$SHA" =~ ^[0-9a-f]{40}$ || ! "$ROUNDS" =~ ^[1-9][0-9]*$ || ! "$SWAP_STABLE" =~ ^[1-9][0-9]*$
      || ! "$SWAP_PROBES" =~ ^[1-9][0-9]*$ || ! "$SWAP_INTERVAL" =~ ^[0-9]+$ ]]; then
      echo "usage: $0 all <full 40-hex commit sha on main> [--precheck]" >&2
      exit 2
    fi
    settings "${DEPLOY_SETTINGS[@]}"
    live_slot_settings "$SHA"
    SITE_URL=https://antwars.ai/
    GAME_SERVICE=antwar
    SLOTS=()
    for ((n = 0; n < PUBLIC_SLOTS; n++)); do SLOTS+=("public-$n"); done
    for ((n = 0; n < PRIVATE_SLOTS; n++)); do SLOTS+=("private-$n"); done
    SERVICES=("$RECORDS_SERVICE")
    for SLOT in "${SLOTS[@]}"; do SERVICES+=("$PREFIX$SLOT"); done
    SERVICES+=("$GAME_SERVICE")
    declare -A OUT_REV=() OUT_SHA=() OUT_IMG=() NEW_REV=() LEFTOVER=()
    # This run: its id names its run marks, and its status file is the one fixed
    # place every run's outcome is read from (RUNNING, DONE or FAILED).
    RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:8}"
    STATUS_FILE="${ANTWAR_ROLLBACK_DIR:-$HOME}/antwar-deploy-status"
    STEP=start
    CURRENT_SLOT=""
    STOP_REASON=""

    stop() { STOP_REASON="$*"; echo "stopping: $*" >&2; exit 1; }
    refuse() { STOP_REASON="$*"; echo "refusing: $*" >&2; exit 1; }
    deploy_stop() { stop "$@"; }
    # A reason the run cannot start: refused at once, or under --precheck
    # collected in BLOCKERS and named with every other one. Returns non-zero.
    BLOCKERS=()
    block() {
      [[ "$PRECHECK" == 1 ]] || refuse "$@"
      BLOCKERS+=("$*")
      echo "blocked: $*" >&2
      return 1
    }
    slot_url() { echo "https://$PREFIX$1-$PROJECT_NUMBER.$REGION.run.app"; }
    # Prints the HTTP status of a request (000 when none arrives).
    http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true; }

    # Run marks. Each revision this run creates is recorded, as soon as it exists,
    # by an empty object running/<sha>/<run>/<revision> in the record input bucket,
    # beside the running/<commit> overlap marks (src/records reads only those, by
    # their exact name). A revision a failed attempt leaves as its service's latest
    # created is let through only when recorded so; it never receives traffic.
    mark_object() { echo "gs://$RECORD_INPUT_BUCKET/running/$SHA/$RUN_ID/$1"; }
    mark_revision() {
      stamp gcloud storage cp - "$(mark_object "$1")" ...
      printf '' | CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud storage cp - "$(mark_object "$1")" \
        --account "$ACCOUNT" --project "$PROJECT" \
        || stop "recording $1 in its run mark $(mark_object "$1") failed; until it is recorded, a later run refuses it"
    }
    # deploy_named records each revision it creates here, before anything else.
    on_created() { mark_revision "$2"; }
    # Every recorded mark name in the bucket, running/<sha>/<run>/<revision>, one
    # per line. An unreadable bucket lists none.
    recorded_marks() {
      CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud storage ls "gs://$RECORD_INPUT_BUCKET/running/**" \
        --account "$ACCOUNT" --project "$PROJECT" </dev/null 2>/dev/null \
        | sed "s#^gs://$RECORD_INPUT_BUCKET/##" \
        | grep -E '^running/[0-9a-f]{40}/[^/[:space:]]+/[^/[:space:]]+$' || true
    }
    # Checks service $1's latest created revision $2 (routing $3) as a failed
    # attempt's leftover: recorded in a run mark, untagged and at 0%. Records it in
    # LEFTOVER, or blocks naming it.
    accept_leftover() {
      local svc="$1" rev="$2" route="$3" serving="$4" mark
      [[ "$MARKS_READ" == 1 ]] || { MARKS="$(recorded_marks)"; MARKS_READ=1; }
      mark="$(grep -E "^running/[0-9a-f]{40}/[^/]+/${rev//./\\.}$" <<<"$MARKS" | head -n 1 || true)"
      [[ "$rev" == "$svc"-* && -n "$mark" ]] \
        || { block "$svc does not serve exactly its latest created revision $rev at 100% (serving: $serving), and $rev is recorded in no run mark"; return 1; }
      [[ "$route" == clear ]] \
        || { block "$svc does not serve exactly its latest created revision $rev at 100% (serving: $serving), and $rev, recorded as $mark, carries traffic or a tag"; return 1; }
      LEFTOVER[$svc]="$rev"
      stamp "$svc: latest created $rev is a recorded leftover ($mark), untagged at 0%; it gets no traffic"
    }
    MARKS=""
    MARKS_READ=0
    # The gates. Each prints why the deploy must wait, or nothing. Every
    # unreadable answer counts as a reason to wait. The bearer token is passed
    # in as an argument and reaches curl on stdin, never on its command line.
    firestore_token() {
      CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud auth print-access-token --account "$ACCOUNT" </dev/null 2>/dev/null || true
    }
    firestore_curl() {
      local token="$1"
      shift
      printf 'Authorization: Bearer %s\n' "$token" | curl -H @- "$@"
    }
    # Prints the busy documents of collection $2 (queueWaiting: the modes with
    # waiting entries; lobbies: id:state of every lobby neither ended nor expired
    # under src/lobby/lobbies.ts isExpired), comma-separated, following every
    # page. Returns non-zero when a page cannot be read.
    firestore_busy() {
      local token="$1" kind="$2" page="" out next items all=""
      while :; do
        local query=(--data-urlencode pageSize=300)
        [[ -z "$page" ]] || query+=(--data-urlencode "pageToken=$page")
        out="$(firestore_curl "$token" -sf -G --max-time 20 "${query[@]}" "$FIRESTORE/$kind" \
          | KIND="$kind" node -e '
            let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
              const page = JSON.parse(s);
              if (page === null || typeof page !== "object" || Array.isArray(page) || page.error) process.exit(1);
              const busy = [];
              // src/lobby/lobbies.ts LOBBY_TTL_MS, CHALLENGE_LOBBY_TTL_MS and isExpired: a player-created
              // lobby, open or waiting, at or after 12 hours from creation; a house challenge lobby (challengeId set) at or
              // after 15 minutes; a queue-made lobby (mode set) never. A missing createdAt is NaN: not expired.
              const LOBBY_TTL_MS = 12 * 60 * 60 * 1000;
              const CHALLENGE_LOBBY_TTL_MS = 15 * 60 * 1000;
              const now = Date.now();
              const expired = (f) => !f.mode?.stringValue && (f.state?.stringValue === "open" || f.state?.stringValue === "waiting")
                && now >= Number(f.createdAt?.stringValue) + (f.challengeId?.stringValue ? CHALLENGE_LOBBY_TTL_MS : LOBBY_TTL_MS);
              for (const doc of page.documents ?? []) {
                const id = doc.name.split("/").pop();
                const f = doc.fields ?? {};
                if (process.env.KIND === "queueWaiting") { if ((f.entries?.stringValue ?? "").trim() !== "") busy.push(id); }
                else if (f.state?.stringValue !== "ended" && !expired(f)) busy.push(`${id}:${f.state?.stringValue ?? "?"}`);
              }
              console.log(page.nextPageToken ?? "");
              console.log(busy.join(","));
            });')" || return 1
        next="$(sed -n 1p <<<"$out")"
        items="$(sed -n 2p <<<"$out")"
        [[ -z "$items" ]] || all="${all:+$all,}$items"
        [[ -n "$next" ]] || break
        page="$next"
      done
      printf '%s\n' "$all"
    }
    # No waiting queue entry and no lobby open (neither ended nor expired).
    global_gate() {
      local token="$1" busy
      [[ -n "$token" ]] || { echo "no Firestore access token"; return 0; }
      busy="$(firestore_busy "$token" queueWaiting)" || { echo "queueWaiting unreadable"; return 0; }
      [[ -z "$busy" ]] || { echo "queue entries waiting in $busy"; return 0; }
      busy="$(firestore_busy "$token" lobbies)" || { echo "lobbies unreadable"; return 0; }
      [[ -z "$busy" ]] || echo "lobbies open: $busy"
    }
    # The global gate (full-gate runs only), then no holder of slot $2, then the
    # slot idle, then still no holder.
    slot_gate() {
      local token="$1" slot="$2" reason code status
      if [[ "$ROLLING" != 1 ]]; then
        reason="$(global_gate "$token")"
        [[ -z "$reason" ]] || { echo "$reason"; return 0; }
      else
        [[ -n "$token" ]] || { echo "no Firestore access token"; return 0; }
      fi
      code="$(firestore_curl "$token" -s -o /dev/null -w '%{http_code}' --max-time 15 "$FIRESTORE/slots/$slot" || true)"
      [[ "$code" == 404 ]] || { echo "slots/$slot answers $code (held)"; return 0; }
      status="$(curl -s --max-time 20 "$(slot_url "$slot")/live/status" || true)"
      [[ "$status" == '{"kind":"idle","match":null}' ]] || { echo "status ${status:-unanswered}"; return 0; }
      code="$(firestore_curl "$token" -s -o /dev/null -w '%{http_code}' --max-time 15 "$FIRESTORE/slots/$slot" || true)"
      [[ "$code" == 404 ]] || echo "slots/$slot answers $code on recheck (held)"
    }
    # Waits for the global gate before $1, a minute between rounds.
    wait_global() {
      local what="$1" round reason
      for ((round = 1; ; round++)); do
        reason="$(global_gate "$(firestore_token)")"
        [[ -n "$reason" ]] || return 0
        stamp "$what waits: $reason"
        ((round < ROUNDS)) || stop "$what is still blocked after $ROUNDS rounds: $reason"
        sleep 60
      done
    }

    # Rolling deploy. Every slot this run withheld and has not released,
    # the slot whose swap is in progress, the records rollback tag kept on the
    # outgoing revision while its builder finishes, and the running/<commit>
    # objects written.
    WITHHELD=()
    IN_FLIGHT=""
    OVERLAP_TAG=""
    RUNNING=()
    # The mark (src/lobby/lobbies.ts withheld/{kind}-{n}): PATCH sets it,
    # DELETE clears it. Each succeeds only on a 200.
    withheld_request() {
      local token="$1" method="$2" slot="$3" code body=()
      [[ "$method" != PATCH ]] || body=(-H 'Content-Type: application/json' --data '{"fields":{}}')
      code="$(firestore_curl "$token" -s -o /dev/null -w '%{http_code}' --max-time 15 -X "$method" \
        ${body[@]+"${body[@]}"} "$FIRESTORE/withheld/$slot" || true)"
      [[ "$code" == 200 ]]
    }
    clear_withheld_command() {
      echo "printf 'Authorization: Bearer %s\\n' \"\$(gcloud auth print-access-token --account $ACCOUNT)\" | curl -H @- -X DELETE '$FIRESTORE/withheld/$1'"
    }
    unwithhold() {
      local s keep=()
      for s in "${WITHHELD[@]}"; do [[ "$s" == "$1" ]] || keep+=("$s"); done
      WITHHELD=(${keep[@]+"${keep[@]}"})
    }
    # The signal (src/records/main.ts): an empty running/<commit> object
    # in the record input bucket.
    running_object() { echo "gs://$RECORD_INPUT_BUCKET/running/$1"; }
    gcloud_storage_command() { echo "gcloud storage $* --account $ACCOUNT --project $PROJECT"; }
    # Written by its exact name with one JSON-API media upload: once a run's
    # marks exist under running/<commit>/, gcloud storage cp - refuses running/<commit>
    # as a folder. The commit is recorded in RUNNING only once the object is written.
    running_upload_url() { echo "https://storage.googleapis.com/upload/storage/v1/b/$RECORD_INPUT_BUCKET/o?uploadType=media&name=running%2F$1"; }
    set_running() {
      local code
      stamp curl -X POST "$(running_upload_url "$1")" ...
      code="$(firestore_curl "$(firestore_token)" -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST \
        -H 'Content-Type: application/octet-stream' --data-binary '' "$(running_upload_url "$1")" || true)"
      [[ "$code" == 200 ]] || stop "writing $(running_object "$1") failed"
      RUNNING+=("$1")
    }
    clear_running() {
      local s keep=()
      stamp gcloud storage rm "$(running_object "$1")" ...
      CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud storage rm "$(running_object "$1")" \
        --account "$ACCOUNT" --project "$PROJECT" </dev/null || stop "removing $(running_object "$1") failed"
      for s in "${RUNNING[@]}"; do [[ "$s" == "$1" ]] || keep+=("$s"); done
      RUNNING=(${keep[@]+"${keep[@]}"})
    }
    # The input bucket's object names, one per line; fails when it cannot be listed.
    input_names() {
      CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud storage ls "gs://$RECORD_INPUT_BUCKET/" \
        --account "$ACCOUNT" --project "$PROJECT" </dev/null \
        | sed "s#^gs://$RECORD_INPUT_BUCKET/##"
    }
    # The match ids of the .input objects in listing $1, one per line.
    input_ids() { sed -n 's/\.input$//p' <<<"$1"; }
    # The ids in $1 whose input is still in listing $2 and that neither builder has
    # given up on: failed-<commit>-3 is the last of MAX_FAILURES (src/records/service.ts).
    drain_left() {
      DRAIN="$1" NAMES="$2" OLD="${OUT_SHA[$RECORDS_SERVICE]}" NEW="$SHA" node -e '
        const names = new Set(process.env.NAMES.split("\n"));
        const left = process.env.DRAIN.split("\n").filter(Boolean).filter((id) => names.has(`${id}.input`)
          && !names.has(`${id}.failed-${process.env.OLD}-3`) && !names.has(`${id}.failed-${process.env.NEW}-3`));
        console.log(left.join(","));'
    }
    # On every exit: clears the marks still set, except a slot mid-swap, names
    # whatever this run leaves behind with the commands that clear it, and writes
    # the run's outcome to STATUS_FILE: DONE, or FAILED with the step, the slot,
    # the reason and the revision every service is left serving.
    on_exit() {
      local rc=$? token slot left=() sha notes=() note svc serving
      trap - INT TERM
      rm -f "${FACTS:-}" "${PROBE_LOG:-}"
      [[ -z "${WORK:-}" ]] || rm -rf "$WORK"
      if [[ ${#WITHHELD[@]} -ne 0 ]]; then
        token="$(firestore_token)"
        for slot in "${WITHHELD[@]}"; do
          if [[ "$slot" != "$IN_FLIGHT" ]] && withheld_request "$token" DELETE "$slot"; then
            stamp "released $PREFIX$slot: withheld/$slot cleared"
          else
            left+=("$slot")
          fi
        done
      fi
      for slot in ${left[@]+"${left[@]}"}; do
        notes+=("left withheld: $PREFIX$slot takes no new match until cleared with: $(clear_withheld_command "$slot")")
      done
      if [[ -n "$OVERLAP_TAG" ]]; then
        notes+=("records overlap still active: $RECORDS_SERVICE ${OUT_REV[$RECORDS_SERVICE]} keeps tag $OVERLAP_TAG so the builder of ${OUT_SHA[$RECORDS_SERVICE]} keeps building its matches' records; once they are built, end the overlap with, in order:")
        notes+=("  gcloud run services update-traffic $RECORDS_SERVICE --account $ACCOUNT --project $PROJECT --region $REGION --clear-tags")
      elif [[ ${#RUNNING[@]} -ne 0 ]]; then
        notes+=("records overlap objects left; remove them with, in order:")
      fi
      for sha in ${RUNNING[@]+"${RUNNING[@]}"}; do
        notes+=("  $(gcloud_storage_command rm "$(running_object "$sha")")")
      done
      for note in ${notes[@]+"${notes[@]}"}; do echo "$note" >&2; done
      {
        if [[ "$rc" == 0 ]]; then
          echo "DONE"
        else
          echo "FAILED"
        fi
        echo "run: $RUN_ID"
        echo "sha: $SHA"
        echo "finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        if [[ "$rc" != 0 ]]; then
          echo "step: $STEP"
          echo "slot: ${CURRENT_SLOT:-none}"
          echo "reason: ${STOP_REASON:-exit status $rc; see the log of this run}"
        fi
        echo "serving:"
        for svc in "${SERVICES[@]}"; do
          serving="${NEW_REV[$svc]:-}"
          if [[ "$rc" != 0 ]]; then
            read -r serving _ _ _ < <(service_state "$svc" 2>/dev/null) || true
            [[ -n "$serving" && "$serving" != NONE ]] || serving="unreadable (no one revision at 100%)"
          fi
          echo "  $svc $serving"
        done
        for note in ${notes[@]+"${notes[@]}"}; do echo "left: $note"; done
      } >"$STATUS_FILE.tmp" && mv -f "$STATUS_FILE.tmp" "$STATUS_FILE" \
        || echo "could not write the deploy status file $STATUS_FILE" >&2
      if [[ "$rc" != 0 ]]; then
        echo "==================== DEPLOY FAILED: $SHA ====================" >&2
        cat "$STATUS_FILE" >&2 2>/dev/null || true
        echo "==============================================================" >&2
      fi
      stamp "deploy status $([[ "$rc" == 0 ]] && echo DONE || echo FAILED) written to $STATUS_FILE"
      exit "$rc"
    }
    # A run interrupted by INT or TERM ends as FAILED; only SIGKILL leaves RUNNING.
    on_signal() { STOP_REASON="interrupted by SIG$1"; echo "stopping: $STOP_REASON" >&2; exit "$2"; }

    # First deploy: creates service $1 with the Cloud Run Admin API's create
    # (services.create), which refuses a service that already exists, so this run
    # never deploys to a service it did not create. The service is created whole,
    # from the same image and the same gcloud run deploy flags $2... any deploy of it
    # takes (create_body), and its one revision is named by this run. On a refusal
    # (409) the run stops before any deploy or traffic move on $1. The run goes on
    # only once that named revision is the service's latest created, latest ready
    # and serving 100%; any other revision there stops it. Records the revision in
    # this run's mark at once (on_created) and sets CREATED_NEW. The bearer reaches
    # curl on stdin.
    create_service() {
      local svc="$1" rev="$1-first-${SHA:0:8}" code body serving created ready try
      shift
      body="$(create_body "$rev" "$@")" || stop "cannot create $svc from its deploy flags (above); nothing was created"
      stamp curl -X POST "$(create_url "$svc")" ... revision "$rev"
      code="$(firestore_curl "$(firestore_token)" -s -o /dev/null -w '%{http_code}' --max-time 60 -X POST \
        -H 'Content-Type: application/json' --data "$body" "$(create_url "$svc")" || true)"
      [[ "$code" != 409 ]] \
        || stop "$svc already exists: the project is no longer empty, so this first deploy stops; nothing was deployed to $svc and none of its traffic moved"
      [[ "$code" == 200 ]] || stop "creating $svc failed (HTTP ${code:-no answer}); nothing was deployed to it"
      on_created "$svc" "$rev"
      for ((try = 1; try <= 60; try++)); do
        read -r serving created ready _ < <(service_state "$svc") || true
        if [[ ( -n "$created" && "$created" != NONE && "$created" != "$rev" ) || ( -n "$serving" && "$serving" != NONE && "$serving" != "$rev" ) ]]; then
          stop "$svc now has latest created revision $created and serves ${serving:-nothing}, not only $rev, the revision this run's create made; nothing further was deployed to it and none of its traffic moved"
        fi
        if [[ "$serving" == "$rev" && "$created" == "$rev" && "$ready" == "$rev" ]]; then
          stamp "$svc created, serving $rev"
          CREATED_NEW="$rev"
          return 0
        fi
        sleep 5
      done
      stop "$svc was created but $rev is not ready and serving 100% after 5 minutes"
    }
    create_url() { echo "https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/services?serviceId=$1"; }
    # Prints, as Cloud Run Admin API (v2) JSON, the service that `gcloud run deploy`
    # with flags $2... creates, its one revision named $1. Exits 1 naming any flag it
    # does not translate, so no deploy flag is dropped from a first deploy unnoticed.
    create_body() {
      REV="$1" node -e '
        const a = process.argv.slice(1), lim = {}, c = { env: [], resources: { limits: lim } };
        const t = { revision: process.env.REV, labels: {}, scaling: {}, containers: [c] };
        const svc = { labels: t.labels, template: t };
        // A flag value split like gcloud: on ^<delimiter>^ when given, else on commas.
        const list = (v) => { const d = /^\^([^^]+)\^/.exec(v); return d ? v.slice(d[0].length).split(d[1]) : v.split(","); };
        const kv = (v) => list(v).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]);
        const num = (v) => (/^[0-9]+$/.test(v) ? Number(v) : v);
        for (let i = 0; i < a.length; i++) {
          const f = a[i], v = a[i + 1];
          switch (f) {
            case "--image": c.image = v; break;
            case "--command": c.command = list(v); break;
            case "--args": c.args = list(v); break;
            case "--set-env-vars": case "--update-env-vars": for (const [name, value] of kv(v)) c.env.push({ name, value }); break;
            case "--set-secrets": case "--update-secrets":
              for (const [name, ref] of kv(v)) c.env.push({ name, valueSource: { secretKeyRef: { secret: ref.split(":")[0], version: ref.split(":")[1] } } });
              break;
            case "--service-account": t.serviceAccount = v; break;
            case "--min-instances": t.scaling.minInstanceCount = Number(v); break;
            case "--max-instances": t.scaling.maxInstanceCount = Number(v); break;
            case "--max": svc.scaling = { maxInstanceCount: Number(v) }; break;
            case "--cpu": lim.cpu = v; break;
            case "--memory": lim.memory = v; break;
            case "--no-cpu-throttling": c.resources.cpuIdle = false; i--; break;
            case "--timeout": t.timeout = v + "s"; break;
            case "--concurrency": t.maxInstanceRequestConcurrency = Number(v); break;
            case "--startup-probe": {
              const probe = (c.startupProbe = {});
              for (const [key, value] of kv(v)) {
                const path = key.split("."), last = path.pop();
                path.reduce((o, k) => (o[k] ??= {}), probe)[last] = num(value);
              }
              break;
            }
            case "--ingress": svc.ingress = { all: "INGRESS_TRAFFIC_ALL", internal: "INGRESS_TRAFFIC_INTERNAL_ONLY" }[v]; if (!svc.ingress) { console.error("unknown --ingress " + v); process.exit(1); } break;
            case "--invoker-iam-check": svc.invokerIamDisabled = false; i--; break;
            case "--no-invoker-iam-check": svc.invokerIamDisabled = true; i--; break;
            case "--labels": for (const [k, value] of kv(v)) t.labels[k] = value; break;
            default: console.error("no create-only translation for the deploy flag " + f); process.exit(1);
          }
          i++;
        }
        console.log(JSON.stringify(svc));' -- "${@:2}"
    }

    # First deploy: every variable and secret each created service runs with,
    # since it has none set outside this script to keep. The operator token is on
    # the game and the public slots only.
    first_deploy_requires() {
      local common="ANTWAR_RECORD_INPUT_BUCKET ANTWAR_REPLAY_BUCKET ANTWAR_CODE_VERSION ANTWAR_PRIVATE_REPLAY_KEY"
      local served="GCLOUD_PROJECT ANTWAR_STORE_NAMESPACE ANTWAR_PUBLIC_SLOTS ANTWAR_PRIVATE_SLOTS ANTWAR_SLOT_URL_TEMPLATE ANTWAR_USERNAME_CLAIM_LIMIT_RULE"
      if [[ "$1" == "$RECORDS_SERVICE" ]]; then echo "$common NODE_OPTIONS"
      elif [[ "$1" == "$GAME_SERVICE" ]]; then echo "$common $served ANTWAR_LOAD_BALANCER_ADDRESS ANTWAR_OPERATOR_TOKEN"
      elif [[ "$1" == "${PREFIX}public-"* ]]; then echo "$common $served ANTWAR_SLOT ANTWAR_PUBLIC_URL ANTWAR_OPERATOR_TOKEN"
      else echo "$common $served ANTWAR_SLOT ANTWAR_PUBLIC_URL"
      fi
    }
    # Prints, space-separated, each of variables $2... that revision $1 does not
    # set to a non-empty value (a secret counts as set); fails when it cannot be read.
    revision_lacks() {
      local rev="$1"
      shift
      run_gcloud run revisions describe "$rev" --format json \
        | NAMES="$*" node -e '
          let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
            const env = JSON.parse(s).spec?.containers?.[0]?.env ?? [];
            const set = (n) => env.some((e) => e.name === n && (e.valueFrom || (typeof e.value === "string" && e.value !== "")));
            console.log(process.env.NAMES.split(" ").filter((n) => !set(n)).join(" "));
          });'
    }

    # Records, slots and the game. A first deploy creates the service with these
    # flags (create_service). Otherwise the serving revision must still be the outgoing
    # one, and the latest created the same or the service's recorded leftover.
    # deploy_named then creates the new revision with no traffic, records it in
    # this run's mark at once (on_created), even when the deploy fails, and once it
    # is Ready moves all traffic to it by name. Sets NEW_REV[$1].
    swap() {
      local svc="$1" serving created
      shift
      if [[ "$FIRST_DEPLOY" == 1 ]]; then
        create_service "$svc" --image "$IMAGE" "$@"
        NEW_REV[$svc]="$CREATED_NEW"
        return 0
      fi
      read -r serving created _ _ < <(service_state "$svc") || true
      [[ "$serving" == "${OUT_REV[$svc]}" && ( "$created" == "$serving" || "$created" == "${LEFTOVER[$svc]:-}" ) ]] \
        || stop "$svc serves ${serving:-nothing readable} (latest created ${created:-?}), not its outgoing revision ${OUT_REV[$svc]}"
      stamp swap "$svc": gcloud run deploy --image "$IMAGE" --no-traffic ..., then gcloud run services update-traffic --to-revisions '<new revision>=100'
      deploy_named "$svc" --image "$IMAGE" "$@"
      NEW_REV[$svc]="$CREATED_NEW"
    }

    # The instance record of slot $2 (src/lobby/lobbies.ts instances/{slot}): the
    # revision it names, or nothing when it cannot be read.
    instance_revision() {
      firestore_curl "$1" -sf --max-time 15 "$FIRESTORE/instances/$2" 2>/dev/null \
        | node -e '
          let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
            try { console.log(JSON.parse(s)?.fields?.revision?.stringValue ?? ""); } catch { console.log(""); }
          });' || true
    }
    # The swap check, run only once all traffic is on the new revision $3 of slot
    # $2 (service $1): it holds the slot only when its instance record names $3,
    # /ready answers 200 and, on a public slot, an unauthenticated POST
    # /operator/stop answers 401 (a private slot has no operator token, and
    # answers 503), on SWAP_STABLE consecutive probes SWAP_INTERVAL seconds apart.
    # A failed probe starts the count again: an instance of the outgoing revision
    # can take the slot back (last boot wins across revisions), and the next
    # request then wakes a new-revision instance that takes it again. Stops after
    # SWAP_PROBES probes without that run, before the next slot is touched; an
    # unauthenticated stop accepted stops at once.
    slot_check() {
      local svc="$1" slot="$2" rev="$3" token="$4" probe pass=0 reason last="" code record
      for ((probe = 1; probe <= SWAP_PROBES; probe++)); do
        reason=""
        code="$(http_code "$(slot_url "$slot")/ready")"
        [[ "$code" == 200 ]] || reason="/ready answers $code, not 200"
        if [[ -z "$reason" ]]; then
          record="$(instance_revision "$token" "$slot")"
          [[ "$record" == "$rev" ]] || reason="instances/$slot names ${record:-no readable revision}, not $rev"
        fi
        if [[ -z "$reason" && "$slot" == public-* ]]; then
          code="$(http_code -X POST "$(slot_url "$slot")/operator/stop")"
          [[ "$code" != 2?? ]] || stop "$svc answers an unauthenticated POST /operator/stop with $code, not 401"
          [[ "$code" == 401 ]] || reason="an unauthenticated POST /operator/stop answers $code, not 401"
        fi
        if [[ -z "$reason" ]]; then
          pass=$((pass + 1))
          stamp "$svc swap check $probe: $rev holds slot $slot ($pass of $SWAP_STABLE in a row)"
          ((pass < SWAP_STABLE)) || return 0
        else
          pass=0
          last="$reason"
          stamp "$svc swap check $probe: $reason"
        fi
        ((probe == SWAP_PROBES)) || sleep "$SWAP_INTERVAL"
      done
      stop "$svc swap check: $rev did not hold slot $slot on $SWAP_STABLE consecutive probes within $SWAP_PROBES; last: ${last:-fewer consecutive passes than needed}"
    }

    # One rollback per service, the outgoing revision: tagged r<first 8 of its
    # commit> on the game; untagged on records and on each slot
    #, whose rollback is restored by revision name, since a tagged old
    # slot revision can start an instance that takes the slot. Every other tag
    # is removed; traffic is not changed.
    keep_rollback() {
      local svc="$1" tag=""
      if [[ "$FIRST_DEPLOY" == 1 ]]; then
        stamp "$svc: no rollback: first deploy, it had no earlier revision"
      elif [[ "$svc" == "$GAME_SERVICE" ]]; then
        tag="r${OUT_SHA[$svc]:0:8}"
        stamp gcloud run services update-traffic "$svc" --set-tags "$tag=${OUT_REV[$svc]}" ...
        run_gcloud run services update-traffic "$svc" --set-tags "$tag=${OUT_REV[$svc]}" || stop "tagging the rollback of $svc failed"
        stamp "$svc" rollback: gcloud run services update-traffic "$svc" --account "$ACCOUNT" --project "$PROJECT" --region "$REGION" --to-tags "$tag=100"
      else
        stamp gcloud run services update-traffic "$svc" --clear-tags ...
        run_gcloud run services update-traffic "$svc" --clear-tags || stop "clearing the tags of $svc failed"
        if [[ "$svc" == "$RECORDS_SERVICE" ]]; then
          stamp records rollback: revision "${OUT_REV[$svc]}", untagged: "$RECORDS_ROLLBACK"
        else
          stamp "$svc" rollback: gcloud run services update-traffic "$svc" --account "$ACCOUNT" --project "$PROJECT" --region "$REGION" --to-revisions "${OUT_REV[$svc]}=100"
        fi
      fi
      check_tags_and_traffic "$svc" "${tag:+${OUT_REV[$svc]}}" "$tag" latest-only \
        || stop "$svc keeps a tag or traffic other than its one rollback (above)"
    }

    # Rolling support shown by the image, for a checkout without the
    # support commits' history. Succeeds only when image $1 is at $REPO by digest
    # and its config carries the label ai.antwars.rolling-support=1: the manifest
    # (or the one linux/amd64 manifest of an index), then its config, read from the
    # registry. Anything else is support not established, with LABEL_REASON set:
    # an image elsewhere (never requested), no access token, a status other than
    # 200 or a redirect, a redirect to a non-https or missing Location, a fourth
    # redirect, or an unreadable answer. Called only as a condition, so no failure
    # inside it stops the run.
    MANIFEST_TYPES="application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"
    image_supports_rolling() {
      local image="$1" dir rc
      LABEL_REASON=""
      [[ "$image" =~ ^"$REPO"@sha256:[0-9a-f]{64}$ ]] || { LABEL_REASON="outside $REPO, not read"; return 1; }
      if [[ "$REGISTRY_TOKEN_READ" != 1 ]]; then
        REGISTRY_TOKEN="$(firestore_token)"
        REGISTRY_TOKEN_READ=1
      fi
      [[ -n "$REGISTRY_TOKEN" ]] || { LABEL_REASON="no registry access token"; return 1; }
      dir="$(mktemp -d)"
      registry_label "$dir" "${image#"$REPO@"}" && rc=0 || rc=1
      rm -rf "$dir"
      return "$rc"
    }
    # Reads the label of digest $2 at $REPO, using directory $1.
    registry_label() {
      local dir="$1" base="https://${REPO%%/*}/v2/${REPO#*/}" next
      registry_get "$dir/manifest" "$base/manifests/$2" || return 1
      next="$(node -e "$MANIFEST_JS" "$dir/manifest" index)" || { LABEL_REASON="$next"; return 1; }
      if [[ "$next" == manifest\ * ]]; then
        registry_get "$dir/manifest" "$base/manifests/${next#manifest }" || return 1
        next="$(node -e "$MANIFEST_JS" "$dir/manifest" manifest)" || { LABEL_REASON="$next"; return 1; }
      fi
      registry_get "$dir/config" "$base/blobs/${next#config }" || return 1
      LABEL_REASON="$(node -e '
        const KEY = "ai.antwars.rolling-support";
        let c;
        try { c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); } catch { console.log("the config is not JSON"); process.exit(1); }
        const labels = c?.config?.Labels ?? {};
        if (!Object.hasOwn(labels, KEY)) { console.log(`the config has no ${KEY} label`); process.exit(1); }
        if (labels[KEY] !== "1") { console.log(`${KEY} is ${JSON.stringify(labels[KEY])}, not "1"`); process.exit(1); }' "$dir/config")"
    }
    # Prints "manifest <digest>" for an index's one linux/amd64 entry (only when
    # $2 is index) or "config <digest>" for a manifest; otherwise the reason, exit 1.
    MANIFEST_JS='
      const fail = (why) => { console.log(why); process.exit(1); };
      const DIGEST = /^sha256:[0-9a-f]{64}$/;
      let m;
      try { m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); } catch { fail("the manifest is not JSON"); }
      if (Array.isArray(m?.manifests)) {
        if (process.argv[2] !== "index") fail("the index entry for linux/amd64 is itself an index");
        const amd64 = m.manifests.filter((e) => e?.platform?.os === "linux" && e?.platform?.architecture === "amd64");
        if (amd64.length !== 1) fail(`the index lists ${amd64.length} linux/amd64 images, not 1`);
        if (!DIGEST.test(amd64[0].digest)) fail("the index entry for linux/amd64 has no sha256 digest");
        console.log("manifest " + amd64[0].digest);
      } else if (DIGEST.test(m?.config?.digest)) console.log("config " + m.config.digest);
      else fail("the manifest names no sha256 config");'
    # Fetches $2 into file $1, following at most 3 redirects. curl is https only
    # and never follows a redirect itself: each Location is resolved against the
    # URL that answered it, must be https, and gets the token only on $REPO's
    # host. Returns non-zero, with LABEL_REASON set, unless the answer is a 200.
    registry_get() {
      local out="$1" url="$2" hop code host next
      for ((hop = 0; ; hop++)); do
        host="$(node -e 'console.log(new URL(process.argv[1]).host)' "$url")" \
          || { LABEL_REASON="$url is not a URL"; return 1; }
        if [[ "$host" == "${REPO%%/*}" ]]; then
          code="$(printf 'Authorization: Bearer %s\n' "$REGISTRY_TOKEN" \
            | curl -s --proto =https --max-time 20 -H @- -H "Accept: $MANIFEST_TYPES" -D "$out.headers" -o "$out" -w '%{http_code}' "$url" || true)"
        else
          code="$(curl -s --proto =https --max-time 20 -H "Accept: $MANIFEST_TYPES" -D "$out.headers" -o "$out" -w '%{http_code}' "$url" </dev/null || true)"
        fi
        case "$code" in
          200) return 0 ;;
          301 | 302 | 303 | 307 | 308) ;;
          *) LABEL_REASON="$url answers ${code:-nothing}"; return 1 ;;
        esac
        ((hop < 3)) || { LABEL_REASON="more than 3 redirects from $2"; return 1; }
        next="$(node -e '
          const [file, base] = process.argv.slice(1);
          const lines = require("node:fs").readFileSync(file, "utf8").split(/\r?\n/);
          const at = lines.filter((l) => /^location:/i.test(l)).map((l) => l.slice(l.indexOf(":") + 1).trim()).at(-1);
          if (!at) process.exit(1);
          console.log(new URL(at, base).href);' "$out.headers" "$url" 2>/dev/null)" \
          || { LABEL_REASON="$url answers $code without a usable Location"; return 1; }
        [[ "$next" == https://* ]] || { LABEL_REASON="$url redirects to $next, not https"; return 1; }
        url="$next"
      done
    }

    # 1. Preflight, for service $1: it must serve exactly one revision at 100% with
    # a readable image digest and ANTWAR_CODE_VERSION, its rollback. A latest created
    # revision that does not serve passes only as a recorded leftover
    # (accept_leftover). Sets OUT_REV, OUT_SHA and OUT_IMG for it, or blocks naming
    # why. Reads only, except the records rollback spec a deploy saves.
    preflight_service() {
      local svc="$1" serving created route spec image commit
      stamp gcloud run services describe "$svc" ...
      read -r serving created _ route < <(service_state "$svc") || true
      [[ -n "$serving" && "$serving" != NONE ]] \
        || { block "$svc does not serve exactly its latest created revision ${created:-?} at 100% (serving: ${serving:-unreadable})"; return 1; }
      [[ "$serving" == "$created" ]] || accept_leftover "$svc" "$created" "$route" "$serving" || return 1
      spec="$FACTS"
      [[ "$svc" != "$RECORDS_SERVICE" || "$PRECHECK" == 1 ]] || spec="${ANTWAR_ROLLBACK_DIR:-$HOME}/records-rollback-$serving.json"
      stamp gcloud run revisions describe "$serving" ...
      read -r image commit < <(revision_facts "$serving" "$spec") \
        || { block "cannot read the image digest and ANTWAR_CODE_VERSION of $serving"; return 1; }
      OUT_REV[$svc]="$serving"
      OUT_SHA[$svc]="$commit"
      OUT_IMG[$svc]="$image"
      if [[ "$svc" == "$RECORDS_SERVICE" ]]; then
        [[ "$image" == "$REPO@"* ]] \
          || { block "$serving runs $image, outside $REPO, so records-rollback could not redeploy it"; return 1; }
        RECORDS_ROLLBACK="$0 records-rollback $commit ${image#"$REPO@"}"
      fi
    }

    # First deploy: FIRST_DEPLOY=1 only when gcloud reports every service absent.
    # Stops reading at the first service present or unreadable, leaving 0 and
    # printing nothing, so the preflight then runs unchanged. Reads only.
    FIRST_DEPLOY=0
    first_deploy_check() {
      local svc
      for svc in "${SERVICES[@]}"; do
        [[ "$(service_state_or_absent "$svc" 2>/dev/null)" == ABSENT ]] || return 0
      done
      FIRST_DEPLOY=1
      stamp "first deploy: all ${#SERVICES[@]} services are absent, so each is created with no rollback, no gate and no domain comparison"
    }
    # The operator token, as the public slots (and a first-created game) take it.
    OPERATOR_TOKEN_SECRET="ANTWAR_OPERATOR_TOKEN=ANTWAR_OPERATOR_TOKEN:latest"
    # The preflight of every service, unless this is a first deploy.
    preflight_all() {
      first_deploy_check
      if [[ "$FIRST_DEPLOY" == 1 ]]; then return 0; fi
      if [[ "$PRECHECK" == 1 ]]; then
        for SERVICE in "${SERVICES[@]}"; do preflight_service "$SERVICE" || true; done
      else
        for SERVICE in "${SERVICES[@]}"; do preflight_service "$SERVICE"; done
      fi
    }

    # --precheck: the preflight alone, changing nothing (no build, deploy, traffic
    # move, mark, status file or saved spec). Names every blocker on stdout and
    # exits 1 when any blocks, else prints clear and exits 0.
    if [[ "$PRECHECK" == 1 ]]; then
      FACTS="$(mktemp)"
      trap 'rm -f "$FACTS"' EXIT
      if ! { git -C "$REPO_ROOT" fetch --quiet origin main && git -C "$REPO_ROOT" merge-base --is-ancestor "$SHA" origin/main; }; then
        block "$SHA is not a commit on origin/main" || true
      fi
      preflight_all
      if [[ ${#BLOCKERS[@]} -eq 0 ]]; then
        echo "precheck $SHA: clear, nothing blocks a deploy of all ${#SERVICES[@]} services"
        exit 0
      fi
      echo "precheck $SHA: ${#BLOCKERS[@]} blocking"
      for B in "${BLOCKERS[@]}"; do echo "blocked: $B"; done
      exit 1
    fi

    # The run starts: from here every exit, and INT or TERM, leaves its outcome
    # in STATUS_FILE; a run killed outright leaves RUNNING.
    printf 'RUNNING\nrun: %s\nsha: %s\nstarted: %s\n' "$RUN_ID" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STATUS_FILE.tmp" \
      && mv -f "$STATUS_FILE.tmp" "$STATUS_FILE" || { echo "refusing: cannot write the deploy status file $STATUS_FILE" >&2; exit 1; }
    trap on_exit EXIT
    trap 'on_signal INT 130' INT
    trap 'on_signal TERM 143' TERM
    stamp "run $RUN_ID: status in $STATUS_FILE"
    STEP=preflight
    require_main_commit "$SHA"
    # probe.mjs, the domain comparison that ends the run, imports this checkout's
    # packages, so they are installed here, before any change: a run from a fresh
    # checkout would otherwise stop at that comparison after every service moved.
    # No package script runs.
    stamp npm ci --ignore-scripts
    (cd "$REPO_ROOT" && npm ci --ignore-scripts --no-audit --no-fund </dev/null >&2) \
      || refuse "npm ci failed in the checkout, so the domain comparison could not run; nothing was changed"
    project_number
    # The load balancer's addresses for the game, read before any gate, build or deploy.
    stamp gcloud compute forwarding-rules list --global ...
    LB_ADDRESSES="$(load_balancer_addresses)" || exit 1
    TEMPLATE="https://$PREFIX{slot}-$PROJECT_NUMBER.$REGION.run.app"
    FIRESTORE="https://firestore.googleapis.com/v1/projects/$PROJECT/databases/(default)/documents/namespaces/$NAMESPACE"

    # Nothing changes unless every service can be rolled back.
    FACTS="$(mktemp)"
    preflight_all

    # A rolling deploy only when every outgoing build honours the slot
    # mark and the records overlap signal: its commit contains both support
    # commits, or else its image carries ai.antwars.rolling-support=1
    # (image_supports_rolling). Otherwise the full gate, unchanged.
    SUPPORT_COMMITS=(46d6c91bcaf385019fc8477646047c85a3263804 e6f22591cd2a40ddcccb084b2c11f49745e12398)
    ROLLING=1
    PREDATES=""
    LABELLED=()
    REGISTRY_TOKEN=""
    REGISTRY_TOKEN_READ=0
    # A first deploy has no outgoing build to check, and is not a rolling deploy.
    [[ "$FIRST_DEPLOY" != 1 ]] || ROLLING=0
    for SERVICE in "${SERVICES[@]}"; do
      [[ "$FIRST_DEPLOY" != 1 ]] || break
      MISSING=""
      for C in "${SUPPORT_COMMITS[@]}"; do
        git -C "$REPO_ROOT" merge-base --is-ancestor "$C" "${OUT_SHA[$SERVICE]}" 2>/dev/null && continue
        MISSING="$C"
        break
      done
      [[ -n "$MISSING" ]] || continue
      stamp reading the rolling-support label of "${OUT_IMG[$SERVICE]}" ...
      if image_supports_rolling "${OUT_IMG[$SERVICE]}"; then
        LABELLED+=("$SERVICE")
        continue
      fi
      ROLLING=0
      PREDATES="$SERVICE runs ${OUT_SHA[$SERVICE]}, which does not contain $MISSING, and its image ${OUT_IMG[$SERVICE]} is not shown to support rolling: $LABEL_REASON"
      break
    done
    if [[ "$FIRST_DEPLOY" == 1 ]]; then
      stamp "first deploy: no gate, since no service exists to hold a match or lobby"
    elif [[ "$ROLLING" == 1 && ${#LABELLED[@]} -eq 0 ]]; then
      stamp "rolling deploy: every outgoing build contains ${SUPPORT_COMMITS[*]}"
    elif [[ "$ROLLING" == 1 ]]; then
      stamp "rolling deploy: every outgoing build contains ${SUPPORT_COMMITS[*]} or carries ai.antwars.rolling-support=1 (by label: ${LABELLED[*]})"
    else
      stamp "full gate: $PREDATES"
    fi

    STEP=build
    image_digest "$REPO" "$SHA"
    IMAGE="$REPO@$DIGEST"

    # 2. Records. Full gate: only while no lobby is open (no match is saved
    # unavailable). Rolling: the outgoing builder keeps running beside the new one,
    # each declared, until its build's matches have their records (step 5).
    STEP="records swap"
    records_flags "$SHA"
    if [[ "$ROLLING" == 1 && "${OUT_SHA[$RECORDS_SERVICE]}" != "$SHA" ]]; then
      set_running "${OUT_SHA[$RECORDS_SERVICE]}"
      set_running "$SHA"
      OVERLAP_TAG="r${OUT_SHA[$RECORDS_SERVICE]:0:8}"
      stamp gcloud run services update-traffic "$RECORDS_SERVICE" --set-tags "$OVERLAP_TAG=${OUT_REV[$RECORDS_SERVICE]}" ...
      run_gcloud run services update-traffic "$RECORDS_SERVICE" --set-tags "$OVERLAP_TAG=${OUT_REV[$RECORDS_SERVICE]}" \
        || stop "tagging $RECORDS_SERVICE ${OUT_REV[$RECORDS_SERVICE]} to keep its builder running failed"
      swap "$RECORDS_SERVICE" "${RECORDS_FLAGS[@]}"
      check_tags_and_traffic "$RECORDS_SERVICE" "${OUT_REV[$RECORDS_SERVICE]}" "$OVERLAP_TAG" latest-only \
        || stop "$RECORDS_SERVICE keeps a tag or traffic other than $OVERLAP_TAG on ${OUT_REV[$RECORDS_SERVICE]} (above)"
    else
      [[ "$ROLLING" == 1 || "$FIRST_DEPLOY" == 1 ]] || wait_global "$RECORDS_SERVICE"
      swap "$RECORDS_SERVICE" "${RECORDS_FLAGS[@]}"
      keep_rollback "$RECORDS_SERVICE"
    fi
    stamp swapped "$RECORDS_SERVICE" "${NEW_REV[$RECORDS_SERVICE]}"

    # 3. Slots, each only while it is free and idle; under the full gate also only
    # while nothing waits and no lobby is open. Rolling: every slot is withheld
    # from new matches first, and each is released once swapped.
    STEP="slot withhold"
    if [[ "$ROLLING" == 1 ]]; then
      TOKEN="$(firestore_token)"
      for SLOT in "${SLOTS[@]}"; do
        WITHHELD+=("$SLOT")
        stamp withhold "$PREFIX$SLOT": PATCH withheld/"$SLOT"
        withheld_request "$TOKEN" PATCH "$SLOT" || stop "withholding $PREFIX$SLOT failed"
      done
    fi
    STEP="slot gate"
    PENDING=("${SLOTS[@]}")
    for ((ROUND = 1; ; ROUND++)); do
      BUSY=()
      TOKEN="$(firestore_token)"
      for SLOT in "${PENDING[@]}"; do
        SERVICE="$PREFIX$SLOT"
        REASON=""
        [[ "$FIRST_DEPLOY" == 1 ]] || REASON="$(slot_gate "$TOKEN" "$SLOT")"
        if [[ -n "$REASON" ]]; then
          BUSY+=("$SLOT")
          stamp "$SERVICE waits: $REASON"
          continue
        fi
        URL="$(slot_url "$SLOT")"
        SECRETS="ANTWAR_PRIVATE_REPLAY_KEY=antwar-private-replay-key:1"
        [[ "$SLOT" != public-* ]] || SECRETS+=",$OPERATOR_TOKEN_SECRET"
        slot_flags "$SLOT" "$URL" "$SECRETS"
        [[ "$ROLLING" != 1 ]] || IN_FLIGHT="$SLOT"
        CURRENT_SLOT="$SLOT"
        STEP="slot swap $SERVICE"
        swap "$SERVICE" "${SLOT_FLAGS[@]}"
        STEP="slot swap check $SERVICE"
        slot_check "$SERVICE" "$SLOT" "${NEW_REV[$SERVICE]}" "$TOKEN"
        STEP="slot rollback $SERVICE"
        keep_rollback "$SERVICE"
        stamp swapped "$SERVICE" "${NEW_REV[$SERVICE]}"
        if [[ "$ROLLING" == 1 ]]; then
          IN_FLIGHT=""
          STEP="slot release $SERVICE"
          stamp release "$SERVICE": DELETE withheld/"$SLOT"
          withheld_request "$TOKEN" DELETE "$SLOT" || stop "releasing $SERVICE (withheld/$SLOT) failed"
          unwithhold "$SLOT"
        fi
        CURRENT_SLOT=""
        STEP="slot gate"
      done
      [[ ${#BUSY[@]} -ne 0 ]] || break
      ((ROUND < ROUNDS)) || stop "still busy after $ROUNDS rounds: ${BUSY[*]/#/$PREFIX}"
      PENDING=("${BUSY[@]}")
      sleep 60
    done
    # Rolling: the inputs the outgoing slots can have left, now that none plays.
    DRAIN=""
    SNAPSHOT=0
    if [[ -n "$OVERLAP_TAG" ]] && NAMES="$(input_names)"; then
      DRAIN="$(input_ids "$NAMES")"
      SNAPSHOT=1
    fi

    # 4. The game: 2 vCPU with the private replay key, no traffic until Ready, and
    # traffic back unless the site answers 200. Full gate: only while no lobby is open.
    STEP="game swap"
    [[ "$ROLLING" == 1 || "$FIRST_DEPLOY" == 1 ]] || wait_global "$GAME_SERVICE"
    # ^;^ makes ; the separator, so the comma list of addresses stays one value.
    # A deploy keeps the game's variables and secrets set outside this script (its
    # store namespace, replay bucket and operator token); a first deploy has none to
    # keep, so it sets them from the live slot settings, the deploy config and the
    # public slots' operator token secret.
    GAME_ENV="^;^GCLOUD_PROJECT=$PROJECT;ANTWAR_RECORD_INPUT_BUCKET=$RECORD_INPUT_BUCKET;ANTWAR_CODE_VERSION=$SHA;ANTWAR_PUBLIC_SLOTS=$PUBLIC_SLOTS;ANTWAR_PRIVATE_SLOTS=$PRIVATE_SLOTS;ANTWAR_SLOT_URL_TEMPLATE=$TEMPLATE;ANTWAR_LOAD_BALANCER_ADDRESS=$LB_ADDRESSES;ANTWAR_USERNAME_CLAIM_LIMIT_RULE=client"
    GAME_SECRETS="ANTWAR_PRIVATE_REPLAY_KEY=antwar-private-replay-key:1"
    if [[ "$FIRST_DEPLOY" == 1 ]]; then
      GAME_ENV+=";ANTWAR_STORE_NAMESPACE=$NAMESPACE;ANTWAR_REPLAY_BUCKET=$REPLAY_BUCKET"
      GAME_SECRETS+=",$OPERATOR_TOKEN_SECRET"
    fi
    swap "$GAME_SERVICE" \
      --update-env-vars "$GAME_ENV" \
      --update-secrets "$GAME_SECRETS" \
      --service-account "$RUN_SA" \
      --min-instances 1 --max-instances 1 \
      --max 1 \
      --no-cpu-throttling \
      --cpu 2 --memory "$MEMORY" \
      --timeout 3600 \
      --concurrency 1000 \
      --ingress all \
      --no-invoker-iam-check \
      --labels "app=antwar,commit=$SHA"
    CREATED="${NEW_REV[$GAME_SERVICE]}"
    for ((TRY = 1; TRY <= 30; TRY++)); do
      SITE="$(http_code "$SITE_URL")"
      [[ "$SITE" != 200 ]] || break
      sleep 10
    done
    if [[ "$SITE" != 200 && "$FIRST_DEPLOY" == 1 ]]; then
      stop "$SITE_URL answered $SITE, not 200, within 5 minutes of $CREATED serving; nothing was reverted, since this first deploy had no earlier revision of $GAME_SERVICE"
    elif [[ "$SITE" != 200 ]]; then
      run_gcloud run services update-traffic "$GAME_SERVICE" --to-revisions "${OUT_REV[$GAME_SERVICE]}=100" || true
      stop "$SITE_URL answered $SITE, not 200, within 5 minutes of $CREATED serving; $GAME_SERVICE traffic was reverted to ${OUT_REV[$GAME_SERVICE]}"
    fi
    NEW_REV[$GAME_SERVICE]="$CREATED"
    keep_rollback "$GAME_SERVICE"
    stamp swapped "$GAME_SERVICE" "$CREATED"

    # Rolling: the outgoing records builder stops once its build's matches have
    # their records; the run then has one records builder and its one rollback.
    if [[ -n "$OVERLAP_TAG" ]]; then
      STEP="records drain"
      for ((ROUND = 1; ; ROUND++)); do
        if NAMES="$(input_names)"; then
          if [[ "$SNAPSHOT" != 1 ]]; then DRAIN="$(input_ids "$NAMES")"; SNAPSHOT=1; fi
          LEFT="$(drain_left "$DRAIN" "$NAMES")"
          [[ -n "$LEFT" ]] || break
          REASON="inputs not yet built: $LEFT"
        else
          REASON="gs://$RECORD_INPUT_BUCKET unreadable"
        fi
        stamp "$RECORDS_SERVICE ${OUT_REV[$RECORDS_SERVICE]} drain waits: $REASON"
        ((ROUND < ROUNDS)) || stop "the records drain is still waiting after $ROUNDS rounds: $REASON"
        sleep 60
      done
      keep_rollback "$RECORDS_SERVICE"
      OVERLAP_TAG=""
      clear_running "${OUT_SHA[$RECORDS_SERVICE]}"
      stamp drained "$RECORDS_SERVICE" "${OUT_REV[$RECORDS_SERVICE]}"
    fi

    # 5. Done only when every service serves its latest ready revision at this commit.
    STEP="final check"
    MISMATCHED=()
    for SERVICE in "${SERVICES[@]}"; do
      read -r SERVING _ READY _ < <(service_state "$SERVICE") || true
      if [[ -z "$SERVING" || "$SERVING" == NONE || "$SERVING" != "$READY" ]]; then
        MISMATCHED+=("$SERVICE serves ${SERVING:-nothing readable}, not its latest ready revision ${READY:-?}")
        continue
      fi
      read -r VERSION CPU KEY OPTOKEN _ < <(revision_shape "$SERVING") || true
      [[ "$VERSION" == "$SHA" ]] || MISMATCHED+=("$SERVICE $SERVING runs ANTWAR_CODE_VERSION ${VERSION:-unreadable}, not $SHA")
      if [[ "$SERVICE" == "$GAME_SERVICE" && ! ( "$CPU" =~ ^(2|2000m)$ && "$KEY" == key ) ]]; then
        MISMATCHED+=("$SERVICE $SERVING runs at cpu ${CPU:-?} with ${KEY:-?}, not 2 vCPU with ANTWAR_PRIVATE_REPLAY_KEY")
      fi
      if [[ "$SERVICE" == "${PREFIX}public-"* && "$OPTOKEN" != token ]]; then
        MISMATCHED+=("$SERVICE $SERVING has no ANTWAR_OPERATOR_TOKEN")
      fi
      if [[ "$FIRST_DEPLOY" == 1 ]]; then
        MISSING="$(revision_lacks "$SERVING" $(first_deploy_requires "$SERVICE"))" \
          || MISSING="its variables (unreadable)"
        [[ -z "$MISSING" ]] || MISMATCHED+=("$SERVICE $SERVING was created without $MISSING")
      fi
      NEW_REV[$SERVICE]="$SERVING"
    done
    if [[ ${#MISMATCHED[@]} -ne 0 ]]; then
      for M in "${MISMATCHED[@]}"; do echo "mismatch: $M" >&2; done
      stop "not done: the services above do not all serve $SHA"
    fi
    # Rolling: the new build's declaration goes last, after the check above, so an
    # outgoing builder still stopping never takes the new build's inputs.
    [[ ${#RUNNING[@]} -eq 0 ]] || clear_running "$SHA"
    for SERVICE in "${SERVICES[@]}"; do echo "$SERVICE ${NEW_REV[$SERVICE]}"; done

    # 6. The domain comparison (probe.mjs domain): https://antwars.ai against the
    # game service's own address, GAME_SERVICE_URL. Its output goes to stderr as it
    # runs. A failure stops the run non-zero and rolls nothing back: every service
    # stays at $SHA. A skip (no public lobby in both catalogs) is reported as a
    # skip, never as a pass.
    STEP="domain comparison"
    if [[ "$FIRST_DEPLOY" == 1 ]]; then
      COMPARISON="SKIPPED, not a pass: first deploy, so ${SITE_URL%/} is not compared with $GAME_SERVICE_URL (the domain may still serve another deployment)"
      stamp domain comparison "$COMPARISON"
      stamp done "$SHA" all "${#SERVICES[@]}" services, domain comparison "$COMPARISON"
      exit 0
    fi
    PROBE_LOG="$(mktemp)"
    stamp node deploy/cloud-run/probe.mjs domain "${SITE_URL%/}" "$GAME_SERVICE_URL" 720
    set +e
    node "$REPO_ROOT/deploy/cloud-run/probe.mjs" domain "${SITE_URL%/}" "$GAME_SERVICE_URL" 720 </dev/null 2>&1 | tee "$PROBE_LOG" >&2
    PROBE_EXIT="${PIPESTATUS[0]}"
    set -e
    if [[ "$PROBE_EXIT" != 0 ]]; then
      stop "domain comparison of ${SITE_URL%/} and $GAME_SERVICE_URL failed (probe exit $PROBE_EXIT, above); nothing was rolled back, every service serves $SHA"
    elif grep -Eq '^[^ ]+ RESULT domain comparison SKIPPED ' "$PROBE_LOG"; then
      COMPARISON="SKIPPED, not a pass: no public lobby in both catalogs"
    elif grep -Eq '^[^ ]+ RESULT domain comparison \{.*"pass":true' "$PROBE_LOG"; then
      COMPARISON=passed
    else
      stop "domain comparison of ${SITE_URL%/} and $GAME_SERVICE_URL reported no result (above); nothing was rolled back, every service serves $SHA"
    fi
    stamp domain comparison "$COMPARISON"
    stamp done "$SHA" all "${#SERVICES[@]}" services, domain comparison "$COMPARISON"
    exit 0
  fi

  if [[ "$MODE" == records || "$MODE" == records-rollback ]]; then
    SHA="${2:-}"
    if [[ "$MODE" == records && ( $# -ne 2 || ! "$SHA" =~ ^[0-9a-f]{40}$ ) ]]; then
      echo "usage: $0 records <full 40-hex commit sha on main>" >&2
      exit 2
    fi
    if [[ "$MODE" == records-rollback && ( $# -ne 3 || ! "$SHA" =~ ^[0-9a-f]{40}$ || ! "${3:-}" =~ ^sha256:[0-9a-f]{64}$ ) ]]; then
      echo "usage: $0 records-rollback <full 40-hex commit sha on main> <sha256:... image digest>" >&2
      exit 2
    fi
    if [[ "$MODE" == records ]]; then
      settings ACCOUNT PROJECT BUILD_BUCKET BUILD_SA RECORDS_SA RECORD_INPUT_BUCKET REPLAY_BUCKET
    else
      settings ACCOUNT PROJECT RECORDS_SA RECORD_INPUT_BUCKET REPLAY_BUCKET
    fi
    require_main_commit "$SHA"
    REPO="$REGION-docker.pkg.dev/$PROJECT/antwar/server"

    # The rollback path is recorded before anything is built or deployed.
    stamp gcloud run services describe "$RECORDS_SERVICE" ...
    OUT_REV="$(serving_revision "$RECORDS_SERVICE")" \
      || { echo "refusing: cannot read the one revision serving $RECORDS_SERVICE, so no rollback path can be recorded" >&2; exit 1; }
    SPEC_FILE="${ANTWAR_ROLLBACK_DIR:-$HOME}/records-rollback-$OUT_REV.json"
    stamp gcloud run revisions describe "$OUT_REV" ... '>' "$SPEC_FILE"
    read -r OUT_IMAGE OUT_SHA < <(revision_facts "$OUT_REV" "$SPEC_FILE") \
      || { echo "refusing: cannot read the image digest and ANTWAR_CODE_VERSION of $OUT_REV" >&2; exit 1; }
    [[ "$OUT_IMAGE" == "$REPO@"* ]] \
      || { echo "refusing: $OUT_REV runs $OUT_IMAGE, outside $REPO, so records-rollback could not redeploy it" >&2; exit 1; }
    OUT_DIGEST="${OUT_IMAGE#"$REPO@"}"

    if [[ "$MODE" == records ]]; then
      image_digest "$REPO" "$SHA"
    else
      # Every build tags its image <repo>:<sha> from that
      # commit, so the given digest must be that tag's. Read only, never built.
      stamp gcloud artifacts docker images describe "$REPO:$SHA" ...
      BUILT_DIGEST="$(CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud artifacts docker images describe "$REPO:$SHA" \
        --account "$ACCOUNT" --project "$PROJECT" \
        --format 'value(image_summary.digest)' </dev/null 2>/dev/null || true)"
      [[ "$BUILT_DIGEST" == "$3" ]] \
        || { echo "refusing: $3 is not the image built from $SHA ($REPO:$SHA is ${BUILT_DIGEST:-unreadable})" >&2; exit 1; }
      DIGEST="$3"
    fi

    # The whole shape restated (records_flags), its traffic moved to the new
    # revision by name (deploy_named).
    records_flags "$SHA"
    stamp gcloud run deploy "$RECORDS_SERVICE" --image "$REPO@$DIGEST" ANTWAR_CODE_VERSION="$SHA" --no-traffic ...
    deploy_named "$RECORDS_SERVICE" --image "$REPO@$DIGEST" "${RECORDS_FLAGS[@]}"

    # No older revision keeps a tag, so none stays warm.
    stamp gcloud run services update-traffic "$RECORDS_SERVICE" --clear-tags ...
    run_gcloud run services update-traffic "$RECORDS_SERVICE" --clear-tags
    stamp records rollback: image "$OUT_IMAGE" from "$OUT_REV", spec "$SPEC_FILE"
    echo "$0 records-rollback $OUT_SHA $OUT_DIGEST"
    stamp gcloud run services describe "$RECORDS_SERVICE" ...
    check_tags_and_traffic "$RECORDS_SERVICE" "" "" latest-only \
      || { echo "deployed $SHA, but $RECORDS_SERVICE still keeps an older revision warm (above)" >&2; exit 1; }
    stamp done "$SHA" "$RECORDS_SERVICE"
    exit 0
  fi

  if [[ "$MODE" == slots-remove ]]; then
    if [[ $# -ne 2 || "$2" != preview ]]; then
      echo "usage: $0 slots-remove preview" >&2
      exit 2
    fi
    settings ACCOUNT PROJECT
    prune_preview_slots
    stamp removed every preview slot service
    exit 0
  fi

  if [[ "$MODE" == slots ]]; then
    TARGET="${2:-}"
    SHA="${3:-}"
    PUBLIC_SLOTS=""
    PRIVATE_SLOTS=""
    if [[ "$TARGET" == preview && ( $# -eq 3 || $# -eq 5 ) ]]; then
      PUBLIC_SLOTS="${4:-1}"
      PRIVATE_SLOTS="${5:-1}"
    elif [[ "$TARGET" == live && $# -eq 3 ]]; then
      PUBLIC_SLOTS="$LIVE_PUBLIC_SLOTS"
      PRIVATE_SLOTS="$LIVE_PRIVATE_SLOTS"
    else
      TARGET=""
    fi
    if [[ -z "$TARGET" || ! "$SHA" =~ ^[0-9a-f]{40}$ || ! "$PUBLIC_SLOTS" =~ ^[1-9][0-9]*$ || ! "$PRIVATE_SLOTS" =~ ^[1-9][0-9]*$ ]]; then
      echo "usage: $0 slots preview <full 40-hex commit sha pushed to origin> [<public slots> <private slots>, each 1 or more]" >&2
      echo "       $0 slots live <full 40-hex commit sha on main>" >&2
      exit 2
    fi

    if [[ "$TARGET" == preview ]]; then
      settings ACCOUNT PROJECT BUILD_BUCKET BUILD_SA RUN_SA
      require_origin_commit "$SHA"
      REPO="$REGION-docker.pkg.dev/$PROJECT/antwar/preview"
      PREFIX=antwar-preview-
      NAMESPACE=preview
      EXTRA_ENV=""
    else
      settings ACCOUNT PROJECT BUILD_BUCKET BUILD_SA RUN_SA RECORD_INPUT_BUCKET REPLAY_BUCKET
      live_slot_settings "$SHA"
      require_main_commit "$SHA"
    fi
    image_digest "$REPO" "$SHA"

    project_number
    # Every slot server wakes the slot it hands a lobby to at this address.
    TEMPLATE="https://$PREFIX{slot}-$PROJECT_NUMBER.$REGION.run.app"

    SLOTS=()
    for ((n = 0; n < PUBLIC_SLOTS; n++)); do SLOTS+=("public-$n"); done
    for ((n = 0; n < PRIVATE_SLOTS; n++)); do SLOTS+=("private-$n"); done
    SERVICES=()
    for SLOT in "${SLOTS[@]}"; do
      SERVICE="$PREFIX$SLOT"
      SERVICES+=("$SERVICE")
      URL="https://$SERVICE-$PROJECT_NUMBER.$REGION.run.app"
      # The whole shape restated (slot_flags), its traffic moved to the new
      # revision by name (deploy_named).
      slot_flags "$SLOT" "$URL" "ANTWAR_PRIVATE_REPLAY_KEY=antwar-private-replay-key:1"
      stamp gcloud run deploy "$SERVICE" --image "$REPO@$DIGEST" ANTWAR_SLOT="$SLOT" ANTWAR_STORE_NAMESPACE="$NAMESPACE" ...
      deploy_named "$SERVICE" --image "$REPO@$DIGEST" "${SLOT_FLAGS[@]}"

      stamp gcloud run services describe "$SERVICE" ...
      CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run services describe "$SERVICE" \
        --account "$ACCOUNT" --project "$PROJECT" \
        --region "$REGION" \
        --format json </dev/null \
        | URL="$URL" node -e '
          let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
            const svc = JSON.parse(s);
            const urls = [svc.status?.url, ...JSON.parse(svc.metadata?.annotations?.["run.googleapis.com/urls"] ?? "[]")];
            if (!urls.includes(process.env.URL)) process.exit(1);
          });' || { echo "deployed $SERVICE, but it does not serve $URL" >&2; exit 1; }
      echo "$SLOT $URL"
    done
    [[ "$TARGET" == preview ]] && prune_preview_slots "${SERVICES[@]}"
    stamp done "$SHA" "$TARGET" "$PUBLIC_SLOTS public" "$PRIVATE_SLOTS private"
    exit 0
  fi

  if [[ "$MODE" == preview-remove ]]; then
    NAME="${2:-}"
    if [[ $# -ne 2 ]] || ! valid_name "$NAME"; then
      echo "usage: $0 preview-remove <name: a-z first, then a-z 0-9 -, at most 20>" >&2
      exit 2
    fi
    settings ACCOUNT PROJECT
    stamp gcloud run services update-traffic "$PREVIEW_SERVICE" --remove-tags "$NAME" ...
    CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run services update-traffic "$PREVIEW_SERVICE" \
      --account "$ACCOUNT" --project "$PROJECT" \
      --region "$REGION" \
      --remove-tags "$NAME" </dev/null
    stamp removed tag "$NAME"
    exit 0
  fi

  SHA="${2:-}"
  NAME="${3:-}"
  RULES="${4:-}"
  PLAYERS="${5:-}"
  if [[ ( $# -ne 3 && $# -ne 5 ) || ! "$SHA" =~ ^[0-9a-f]{40}$ ]] || ! valid_name "$NAME" \
    || [[ $# -eq 5 && ! ( "$RULES" =~ ^(v4|count-marks|redesign)$ && "$PLAYERS" =~ ^(2|4)$ ) ]]; then
    echo "usage: $0 preview <full 40-hex commit sha pushed to origin> <name: a-z first, then a-z 0-9 -, at most 20> [<rules: v4|count-marks|redesign> <players: 2|4>]" >&2
    exit 2
  fi
  settings ACCOUNT PROJECT BUILD_BUCKET BUILD_SA RUN_SA
  REPO="$REGION-docker.pkg.dev/$PROJECT/antwar/preview"
  # The shared store's project is set on every revision. gcloud accepts
  # --update-env-vars with --remove-env-vars, and applies the removal first.
  if [[ $# -eq 5 ]]; then
    ENV_FLAG=(--update-env-vars "GCLOUD_PROJECT=$PROJECT,ANTWAR_RULES=$RULES,ANTWAR_PLAYERS=$PLAYERS")
  else
    ENV_FLAG=(--update-env-vars "GCLOUD_PROJECT=$PROJECT" --remove-env-vars ANTWAR_RULES,ANTWAR_PLAYERS)
  fi

  require_origin_commit "$SHA"
  image_digest "$REPO" "$SHA"

  # Same shape as the live service except scaling: no minimum, and at most one
  # instance for each revision, so one per direction. No --no-traffic: gcloud
  # refuses it when the deploy creates the service.
  stamp gcloud run deploy "$PREVIEW_SERVICE" --image "$REPO@$DIGEST" --tag "$NAME" "${ENV_FLAG[@]}" ...
  CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run deploy "$PREVIEW_SERVICE" \
    --account "$ACCOUNT" --project "$PROJECT" \
    --region "$REGION" \
    --image "$REPO@$DIGEST" \
    --tag "$NAME" \
    "${ENV_FLAG[@]}" \
    --service-account "$RUN_SA" \
    --min-instances 0 --max-instances 1 \
    --no-cpu-throttling \
    --cpu 1 --memory "$MEMORY" \
    --timeout 3600 \
    --concurrency 1000 \
    --ingress all \
    --no-invoker-iam-check \
    --labels "app=antwar,commit=$SHA" </dev/null

  stamp gcloud run services describe "$PREVIEW_SERVICE" ...
  URL="$(CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run services describe "$PREVIEW_SERVICE" \
    --account "$ACCOUNT" --project "$PROJECT" \
    --region "$REGION" \
    --format json </dev/null \
    | TAG="$NAME" node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const hit = (JSON.parse(s).status?.traffic ?? []).find((t) => t.tag === process.env.TAG);
        if (!hit?.url) process.exit(1);
        console.log(hit.url);
      });')" || { echo "deployed, but no address found for tag $NAME" >&2; exit 1; }
  stamp done "$SHA" "$NAME"
  echo "$URL"
  exit 0
fi

SHA="${1:-}"
if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: $0 <full 40-hex commit sha on main>" >&2
  exit 2
fi

load_deploy_config ACCOUNT PROJECT BUILD_BUCKET BUILD_SA RUN_SA RECORD_INPUT_BUCKET
REGION=australia-southeast1
IMAGE="$REGION-docker.pkg.dev/$PROJECT/antwar/server:$SHA"
BUCKET="gs://$BUILD_BUCKET"
# Instance memory: the server keeps at most 10 finished match logs plus the live one
# in DATA_DIR, which is held in memory on Cloud Run; the sizing is in the report.
MEMORY=2Gi
# RECORD_INPUT_BUCKET is the record service's private input bucket
# (record-service-setup.sh), where this server hands each recorded match.
# --update-env-vars sets only GCLOUD_PROJECT, it, ANTWAR_CODE_VERSION, the
# live slot settings (ANTWAR_PUBLIC_SLOTS, ANTWAR_PRIVATE_SLOTS,
# ANTWAR_SLOT_URL_TEMPLATE), ANTWAR_LOAD_BALANCER_ADDRESS (the antwars.ai
# forwarding-rule addresses, read at deploy time) and the username claim limit's rule
# (ANTWAR_USERNAME_CLAIM_LIMIT_RULE=client); variables set outside this script are kept.
# Its ^;^ prefix makes ; the separator, so the address list's commas stay inside one value.

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
git -C "$REPO_ROOT" fetch --quiet origin main
if ! git -C "$REPO_ROOT" merge-base --is-ancestor "$SHA" origin/main; then
  echo "refusing: $SHA is not a commit on origin/main" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git -C "$REPO_ROOT" archive --format=tar.gz -o "$WORK/source.tgz" "$SHA"

# Print each gcloud command with its UTC start time before it runs.
stamp() { printf '+ %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# The live slot services' address template, from Cloud Run's deterministic
# service URL, as `slots live` sets it on the slot services.
stamp gcloud projects describe "$PROJECT" ...
PROJECT_NUMBER="$(CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud projects describe "$PROJECT" \
  --account "$ACCOUNT" \
  --format 'value(projectNumber)' </dev/null)"
[[ "$PROJECT_NUMBER" =~ ^[0-9]+$ ]] || { echo "unexpected project number: $PROJECT_NUMBER" >&2; exit 1; }
SLOT_URL_TEMPLATE="https://antwar-{slot}-$PROJECT_NUMBER.$REGION.run.app"

# The load balancer's addresses, read before anything is built or deployed.
stamp gcloud compute forwarding-rules list --global ...
LB_ADDRESSES="$(load_balancer_addresses)" || exit 1

# The revision serving now becomes the one rollback revision; read it
# before anything is built or deployed.
stamp gcloud run services describe antwar ...
OUT_REV="$(serving_revision antwar)" \
  || { echo "refusing: cannot read the one revision serving antwar, so no rollback tag can be set" >&2; exit 1; }
stamp gcloud run revisions describe "$OUT_REV" ...
read -r _ OUT_SHA < <(revision_facts "$OUT_REV" "$WORK/rollback-revision.json") \
  || { echo "refusing: cannot read the image digest and ANTWAR_CODE_VERSION of $OUT_REV" >&2; exit 1; }
ROLLBACK_TAG="r${OUT_SHA:0:8}"

stamp gcloud builds submit "$WORK/source.tgz" --tag "$IMAGE" ...
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud builds submit "$WORK/source.tgz" \
  --account "$ACCOUNT" --project "$PROJECT" \
  --region "$REGION" \
  --tag "$IMAGE" \
  --service-account "projects/$PROJECT/serviceAccounts/$BUILD_SA" \
  --gcs-source-staging-dir "$BUCKET/source" \
  --gcs-log-dir "$BUCKET/logs" </dev/null

# The new revision gets all traffic by name (deploy_named), never "latest".
stamp gcloud run deploy antwar --image "$IMAGE" --no-traffic ...
deploy_named antwar \
  --image "$IMAGE" \
  --update-env-vars "^;^GCLOUD_PROJECT=$PROJECT;ANTWAR_RECORD_INPUT_BUCKET=$RECORD_INPUT_BUCKET;ANTWAR_CODE_VERSION=$SHA;ANTWAR_PUBLIC_SLOTS=$LIVE_PUBLIC_SLOTS;ANTWAR_PRIVATE_SLOTS=$LIVE_PRIVATE_SLOTS;ANTWAR_SLOT_URL_TEMPLATE=$SLOT_URL_TEMPLATE;ANTWAR_LOAD_BALANCER_ADDRESS=$LB_ADDRESSES;ANTWAR_USERNAME_CLAIM_LIMIT_RULE=client" \
  --service-account "$RUN_SA" \
  --min-instances 1 --max-instances 1 \
  --max 1 \
  --no-cpu-throttling \
  --cpu 1 --memory "$MEMORY" \
  --timeout 3600 \
  --concurrency 1000 \
  --ingress all \
  --no-invoker-iam-check \
  --labels "app=antwar,commit=$SHA"

# --set-tags replaces every tag, so only the one rollback revision
# stays warm besides the serving one; traffic is left where deploy_named moved it.
stamp gcloud run services update-traffic antwar --set-tags "$ROLLBACK_TAG=$OUT_REV" ...
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run services update-traffic antwar \
  --account "$ACCOUNT" --project "$PROJECT" \
  --region "$REGION" \
  --set-tags "$ROLLBACK_TAG=$OUT_REV" </dev/null
stamp game rollback: revision "$OUT_REV", tag "$ROLLBACK_TAG"
echo "gcloud run services update-traffic antwar --account $ACCOUNT --project $PROJECT --region $REGION --to-tags $ROLLBACK_TAG=100"
stamp gcloud run services describe antwar ...
check_tags_and_traffic antwar "$OUT_REV" "$ROLLBACK_TAG" "" \
  || { echo "deployed $SHA, but antwar keeps a tag other than $ROLLBACK_TAG on $OUT_REV (above)" >&2; exit 1; }

stamp done "$SHA"
