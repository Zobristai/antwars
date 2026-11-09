# antwar on Cloud Run: what was created, and how to remove it

The configured project (`PROJECT`), region `australia-southeast1`. Everything
below was created new for antwar; nothing that existed before was changed.

Names in capitals are settings of the private deploy config file that
`deploy.sh`, `record-service-setup.sh` and `domain.sh` read (named by
`ANTWAR_DEPLOY_CONFIG`; `deploy.env.example` lists them). The commands below use
them as shell variables: set `ACCOUNT`, `PROJECT`, `BUILD_BUCKET`, `BUILD_SA`,
`RUN_SA`, `RECORDS_SA`, `RECORD_INPUT_BUCKET` and `REPLAY_BUCKET` to those values
first. Bucket settings are bare names, without `gs://`.
Resources whose type supports labels carry `app=antwar`; the others are named
`antwar-` where they have a name.

## Resources

| resource | name | label | notes |
|---|---|---|---|
| Cloud Run service (and its revisions) | `antwar` | `app=antwar` (revisions inherit it, plus `commit=<sha>`) | public: ingress all, invoker IAM check off |
| Cloud Run service (and its revisions) | `antwar-preview` | `app=antwar` (revisions inherit it, plus `commit=<sha>`) | preview mode of `deploy.sh`; one traffic tag per design direction; runs as `antwar-run`; public the same way as `antwar`; minimum 0 and at most 1 instance per revision |
| Cloud Run services (and their revisions) | `antwar-preview-public-<n>`, `antwar-preview-private-<n>` | `app=antwar`, `antwar-slots=preview` (revisions add `commit=<sha>`) | `deploy.sh slots preview`: one lobby match slot each, at most one instance and none kept running while idle (woken when its slot is assigned), runs as `antwar-run`, namespace `preview` in the default Firestore database, secret `antwar-private-replay-key` version 1 as `ANTWAR_PRIVATE_REPLAY_KEY`, no replay bucket; public the same way as `antwar` |
| Cloud Run services (and their revisions) | `antwar-public-0` to `antwar-public-7`, `antwar-private-0` to `antwar-private-7` | `app=antwar`, `antwar-slots=live` (revisions add `commit=<sha>`) | `deploy.sh slots live`, 8 public and 8 private, run only when scheduled: as the preview slots, but namespace `live`, image `server:<sha>`, and replay bucket `REPLAY_BUCKET` |
| Cloud Run service (and its revisions) | `antwar-records` | `app=antwar` (revisions add `commit=<sha>`) | `deploy.sh records`: the record service, its own service and not a game-server mode or revision; main commits only; image `server:<sha>` started as `npm run record-service`; runs as `antwar-records`; exactly one instance kept running, CPU always allocated, 1 vCPU, 2 GiB; `NODE_OPTIONS=--max-old-space-size=512`, `ANTWAR_RECORD_INPUT_BUCKET=<RECORD_INPUT_BUCKET>`, `ANTWAR_REPLAY_BUCKET=<REPLAY_BUCKET>`, `ANTWAR_CODE_VERSION=<sha>`, secret `antwar-private-replay-key` version 1 as `ANTWAR_PRIVATE_REPLAY_KEY`; ingress internal, invoker IAM check on |
| Cloud Storage bucket | `gs://<RECORD_INPUT_BUCKET>` | `app=antwar` | `record-service-setup.sh`: private match inputs waiting for their records; uniform access, public access prevention enforced, soft delete off, no lifecycle rule |
| Artifact Registry repository (docker) | `antwar` | `app=antwar` | holds images `server:<main sha>` and, from preview mode, `preview:<sha>`; images themselves take no labels |
| Cloud Storage bucket | `gs://<BUILD_BUCKET>` | `app=antwar` | Cloud Build source (`source/`) and build logs (`logs/`); for a Cloud Build deploy run (`cloudbuild.yaml`), its status file and records rollback spec (`deploys/<build id>/`; its log is in Cloud Logging) |
| Service account (no labels) | `RUN_SA` (`antwar-run`) | none possible | the service's identity; holds only the grants below |
| Service account (no labels) | `BUILD_SA` (`antwar-build`) | none possible | Cloud Build's identity for antwar builds |
| Service account (no labels) | `RECORDS_SA` (`antwar-records`) | none possible | `record-service-setup.sh`: the record service's identity; holds only the grants below |
| Cloud Build build records (no labels) | one per `deploy.sh` run, preview runs included, plus one per Cloud Build deploy run (`cloudbuild.yaml`) | none possible | listed by image tag; Cloud Build keeps them and they cannot be deleted |

## Role grants (the only ones made)

| member | role | scope |
|---|---|---|
| `serviceAccount:<BUILD_SA>` | `roles/artifactregistry.writer` | repository `antwar` only |
| `serviceAccount:<BUILD_SA>` | `roles/storage.objectUser` | bucket `gs://<BUILD_BUCKET>` only |
| `serviceAccount:<BUILD_SA>` | `roles/storage.legacyBucketReader` | bucket `gs://<BUILD_BUCKET>` only; added because Cloud Build refused the bucket ("does not have access to the bucket") with objectUser alone |
| `serviceAccount:<RUN_SA>` | `roles/storage.objectCreator` | bucket `gs://<RECORD_INPUT_BUCKET>` only (`record-service-setup.sh`: the game server only creates inputs) |
| `serviceAccount:<RUN_SA>` | `roles/storage.objectViewer` | bucket `gs://<RECORD_INPUT_BUCKET>`, condition `antwar-run-handover-saves-read`: objects under `handover/` only (`record-service-setup.sh`: slot servers read back handover saves; no listing) |
| `serviceAccount:<RECORDS_SA>` | `roles/storage.objectUser` | bucket `gs://<RECORD_INPUT_BUCKET>` only (`record-service-setup.sh`: lists, reads, writes failure markers in and deletes inputs) |
| `serviceAccount:<RECORDS_SA>` | `roles/storage.objectUser` | bucket `gs://<REPLAY_BUCKET>` only (`record-service-setup.sh`: generation-checked rebuilds of unavailable records need get, create and delete; the service sends no delete and never changes binaries) |
| `serviceAccount:<RECORDS_SA>` | `roles/secretmanager.secretAccessor` | secret `antwar-private-replay-key` only (`record-service-setup.sh`) |

No project-level grant, no owner or editor role, and no service-account key.

## Teardown

To remove one preview direction only (its tag; the revision stays until the service is deleted):

```bash
deploy/cloud-run/deploy.sh preview-remove <name>
```

To remove every preview slot service (they bill while running):

```bash
deploy/cloud-run/deploy.sh slots-remove preview
```

The slot services use the Firestore database, its `antwar-run` access and the
secret `antwar-private-replay-key` (not created here). Their documents stay under `namespaces/preview` and `namespaces/live`.

To remove only the record service, run in this order. Inputs still in
the bucket go with it, and their matches never get a record. The replay bucket
and the secret were not created here, so only their grants are removed.

```bash
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run services delete antwar-records --region australia-southeast1 --account "$ACCOUNT" --project "$PROJECT"
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud secrets remove-iam-policy-binding antwar-private-replay-key --member "serviceAccount:$RECORDS_SA" --role roles/secretmanager.secretAccessor --account "$ACCOUNT" --project "$PROJECT"
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud storage buckets remove-iam-policy-binding "gs://$REPLAY_BUCKET" --member "serviceAccount:$RECORDS_SA" --role roles/storage.objectUser --account "$ACCOUNT" --project "$PROJECT"
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud storage rm --recursive "gs://$RECORD_INPUT_BUCKET" --account "$ACCOUNT" --project "$PROJECT"
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud iam service-accounts delete "$RECORDS_SA" --account "$ACCOUNT" --project "$PROJECT"
```

To remove everything, run the record-service removal above first, then this, in this order. Each grant goes with the resource it is bound to.

```bash
for slot in public-{0..7} private-{0..7}; do CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run services delete "antwar-$slot" --region australia-southeast1 --account "$ACCOUNT" --project "$PROJECT"; done
deploy/cloud-run/deploy.sh slots-remove preview
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run services delete antwar-preview --region australia-southeast1 --account "$ACCOUNT" --project "$PROJECT"
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud run services delete antwar --region australia-southeast1 --account "$ACCOUNT" --project "$PROJECT"
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud artifacts repositories delete antwar --location australia-southeast1 --account "$ACCOUNT" --project "$PROJECT"
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud storage rm --recursive "gs://$BUILD_BUCKET" --account "$ACCOUNT" --project "$PROJECT"
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud iam service-accounts delete "$RUN_SA" --account "$ACCOUNT" --project "$PROJECT"
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud iam service-accounts delete "$BUILD_SA" --account "$ACCOUNT" --project "$PROJECT"
```

The antwar build records (main and preview) stay in Cloud Build's history. List them with:

```bash
gcloud builds list --region australia-southeast1 --filter 'images~antwar/' --account "$ACCOUNT" --project "$PROJECT"
```

## Production deploys (Cloud Build)

A production deploy runs `deploy.sh` in Cloud Build (`cloudbuild.yaml`), as the
config's `ACCOUNT`: the deploy service account, which the build refuses to run as
any other identity. Each build is submitted for one named commit on main, once
that deploy is approved. Whoever submits it, a person's gcloud login or an
automated job signed in as `ACCOUNT` without a key file, needs
`cloudbuild.builds.create` and `iam.serviceAccounts.actAs` on `ACCOUNT`; the build
log is in Cloud Logging, so `ACCOUNT` holds `roles/logging.logWriter`, and
`run.services.setIamPolicy` for the invoker setting `deploy.sh` restates on every
service.

Run this from a clean checkout of this repository at the named commit, with
`ANTWAR_DEPLOY_CONFIG` naming the private config file and its `ACCOUNT` set to the
deploy service account. Set `SHA` to the commit's full 40-hex sha and `RUN` to one
of the three forms below; the build clones that commit from this repository and
runs its own `cloudbuild-run.sh`.

```bash
SHA=<full 40-hex commit sha on main>
git checkout --detach "$SHA"
# The deploy itself: `deploy.sh all <sha>`, every gate included.
RUN="TAG_NAME=deploy-$SHA,COMMIT_SHA=$SHA"
# Or the precheck, which changes nothing: `deploy.sh all <sha> --precheck`.
RUN="COMMIT_SHA=$SHA,_ARGS=all $SHA --precheck"
# Or a records rollback: SHA is the commit whose deploy printed the rollback
# command, and <rollback sha> <sha256:digest> are that command's two arguments.
RUN="COMMIT_SHA=$SHA,_ARGS=records-rollback <rollback sha> <sha256:digest>"
(
  source deploy/cloud-run/config.sh && load_deploy_config "${DEPLOY_SETTINGS[@]}"
  gcloud builds submit --no-source --config deploy/cloud-run/cloudbuild.yaml \
    --region australia-southeast1 --project "$PROJECT" \
    --service-account "projects/$PROJECT/serviceAccounts/$ACCOUNT" \
    --substitutions "$RUN,_ACCOUNT=$ACCOUNT,_BUILD_BUCKET=$BUILD_BUCKET,_BUILD_SA=$BUILD_SA,_RUN_SA=$RUN_SA,_RECORDS_SA=$RECORDS_SA,_RECORD_INPUT_BUCKET=$RECORD_INPUT_BUCKET,_REPLAY_BUCKET=$REPLAY_BUCKET,_GAME_SERVICE_URL=$GAME_SERVICE_URL"
)
```

A precheck passes when the build log ends `precheck <sha>: clear`. Each build
saves `deploy.sh`'s status file and any records rollback spec to
`gs://<BUILD_BUCKET>/deploys/<build id>/`.

### Not set up: a tag trigger

A Cloud Build trigger would post the project ID and trigger name to GitHub's
checks on this public repository, so none is set up. `cloudbuild.yaml` already accepts a
trigger's build, which takes the pushed tag and commit from the built-in
`TAG_NAME` and `COMMIT_SHA` exactly as the deploy form above sets them.
Once that is resolved:

- A Cloud Build 2nd-gen GitHub connection, region `australia-southeast1`: the
  Cloud Build GitHub App installed on the GitHub organization, and its
  authorization token in Secret Manager, with the repository linked to it.
  Removed, after the trigger, with `gcloud builds connections delete <connection>
  --region australia-southeast1 --project "$PROJECT"`, then by uninstalling the
  app on GitHub.
- A trigger on a pushed tag matching `^deploy-[0-9a-f]{40}$`, running
  `deploy/cloud-run/cloudbuild.yaml` as `ACCOUNT`, with the settings above as its
  substitutions. Removed with `gcloud builds triggers delete <trigger> --region
  australia-southeast1 --project "$PROJECT"`.
- A repository ruleset limiting creation and deletion of `deploy-*` tags to
  repository admins, so creating the tag stays the go for a deploy.

## antwars.ai front end

The front end uses a **classic Compute Google-managed SSL certificate**, not
Certificate Manager. Certificate Manager stays disabled. No API is
enabled. An operator, not the change's author, runs the reviewed and published
head on the deploy host. Neither script phase builds or deploys anything, calls a Cloud
Run mutation, changes traffic/settings/image/revisions, writes DNS, grants IAM,
or reads/prints credentials. The backing service remains `antwar` in Sydney.

### Resources (complete inventory)

All names below are new, in the configured project (`PROJECT`). All are global except the NEG.

- `antwar-domain-ip`: one Premium global external IPv4 address; `app=antwar`.
- `antwar-domain-neg`: SERVERLESS NEG, `australia-southeast1`, pointing only to
  service `antwar`, without a revision tag or URL mask; labels unsupported.
- `antwar-domain-backend`: global EXTERNAL_MANAGED HTTP backend, only that NEG;
  no health checks, CDN or additional logging; labels unsupported.
- `antwar-domain-cert`: classic Google-managed SSL, `antwars.ai` and
  `www.antwars.ai`; no key material; labels unsupported.
- `antwar-domain-url-map`: default backend above; www redirects 301 to HTTPS
  apex, preserving path and query; labels unsupported.
- `antwar-domain-http-redirect`: all HTTP redirects 301 to HTTPS apex,
  preserving path and query; labels unsupported.
- `antwar-domain-https-proxy`: global HTTPS proxy using that certificate and
  HTTPS URL map; labels unsupported.
- `antwar-domain-http-proxy`: global HTTP proxy using the redirect map; labels
  unsupported.
- `antwar-domain-https`: global EXTERNAL_MANAGED Premium TCP/443 forwarding rule
  on that IP to the HTTPS proxy; `app=antwar`.
- `antwar-domain-http`: global EXTERNAL_MANAGED Premium TCP/80 forwarding rule
  on that IP to the HTTP proxy; `app=antwar`.

### Reviewed execution and reruns

Use Node 24 and the existing gcloud installation, without changing the deploy host's
configuration. Every invocation passes `--quiet` with the configured `--account`
(`ACCOUNT`) and `--project` (`PROJECT`), and disables prompts for that process. Read/API failures
stop rather than being treated as missing resources. The operator reads
`domain.sh` at the reviewed SHA before running it, and stops on any partial
failure, service mutation or resource outside the inventory. The same reviewed
SHA covers both phases.

1. Complete read-only forwarding-rule count/name checks and service/revision
   baseline. Return output and report fixed cost before any creation.
2. Run `bash deploy/cloud-run/domain.sh reserve-ip` from the reviewed head.
   This phase creates only the IP, applies its label, and prints both exact A
   records. **Hand these records to whoever manages DNS immediately**, before
   starting the next phase.
3. Run `bash deploy/cloud-run/domain.sh create-remaining` at that same head only
   once the DNS records are confirmed. It attaches the reserved IP to the front end.
4. Run `bash deploy/cloud-run/domain.sh describe`, then repeat the secret-safe
   service hash, serving revision describe and revision list from the baseline.
   Compare the canonical service spec and metadata hashes, images, traffic and
   revision names. Do not publish raw environment-variable values. Stop on
   changes; the script never attempts to restore the service.

Existing objects must have the script's ownership description and matching
configuration, except the NEG: its create command has no description flag, so
its exact reserved name, SERVERLESS type, `cloudRun.service=antwar`, and absence
of tag/mask are its ownership proof. Matching objects are skipped without
mutation; conflicting or half-created objects stop the run before writes. The script does not reconcile
existing infrastructure. CLI create is INSERT-only: a concurrent name collision
stops. Address/forwarding-rule labels are finished only immediately after their
successful creation in this invocation. Because URL-map create has no redirect
flag, each URL map's name is first claimed by create, then its final configuration
is imported **only in that same invocation**. No import or label update runs on
an object found by the initial inventory. A failed finishing operation requires
a new, reviewed recovery instruction; do not blindly retry or delete it.

### Read-only comparison defaults audit

The create-only and describe preflights compare configuration, not whether an
API response serialized an optional default. The comparison substitutes only a
**missing own property**, at an explicitly listed resource-kind/full-field path.
It never inserts fields into the returned object, writes the cloud, repairs a
resource, substitutes for `null`, or treats arbitrary falsy values as defaults.
All array lengths, required references, ownership checks and forbidden-policy
checks remain unchanged. A documented default that differs from this front
end's desired value still fails comparison.

The checked-field audit covers every resource kind, including objects after the
HTTP redirect in preflight order. Only `stripQuery` omission has been observed
in live API output; the other cases below are defended from their
documented semantics, not claimed as additional observed omissions.

| Checked fields | Documented omission semantics and comparison |
| --- | --- |
| Address `addressType`, `networkTier` | Missing means `EXTERNAL` and `PREMIUM`, respectively, both matching this front end. Normalize those two fields only. The [global Address API](https://docs.cloud.google.com/compute/docs/reference/rest/v1/globalAddresses) explicitly states both defaults. |
| Address `ipVersion`, `address`, `labels.app`; every resource name and ownership description | Keep required: the Address REST description lists IPv4/IPv6 but does not promise an omitted-read `ipVersion` default. An actual IPv4 value, the expected label and the script's exact name/description are still needed. A CLI creation preference is not evidence that a missing API response field has that value. |
| NEG `networkEndpointType`, `cloudRun.service` | No matching omitted-field default is documented for `SERVERLESS` or service `antwar`. Both must be present. [NetworkEndpointGroup API](https://docs.cloud.google.com/compute/docs/reference/rest/v1/networkEndpointGroups) and [Cloud Run NEG schema](https://www.googleapis.com/discovery/v1/apis/compute/v1/rest?fields=schemas/NetworkEndpointGroupCloudRun). Tags, masks, other serverless targets and network/subnetwork remain forbidden as before. |
| Backend `enableCDN` | Absent is disabled (`false`), matching this front end. The [BackendService API](https://docs.cloud.google.com/compute/docs/reference/rest/v1/backendServices) defines true as enabling CDN; the [official create reference](https://docs.cloud.google.com/sdk/gcloud/reference/compute/backend-services/create) explicitly states “Cloud CDN is disabled by default.” Only this service-field semantic is used, not a generic rule for absent booleans. |
| Backend `protocol`, `loadBalancingScheme`, `backends[].group` | Preserve explicit `HTTP`, `EXTERNAL_MANAGED` and the exact NEG reference. The [current API schema](https://www.googleapis.com/discovery/v1/apis/compute/v1/rest?fields=schemas/BackendService/properties(protocol,enableCDN,loadBalancingScheme)) does not document an omitted-response HTTP or EXTERNAL_MANAGED default. Creation-command defaults do not establish one. Required backends and cardinality stay strict. |
| Certificate `type`, `managed.domains[]` | The [SslCertificate API](https://docs.cloud.google.com/compute/docs/reference/rest/v1/sslCertificates) says unspecified type is self-managed. Compare missing type as `SELF_MANAGED`, which **fails** desired `MANAGED`. Both exact domains remain required. Provisioning status is reported, not substituted with ACTIVE. |
| HTTP `defaultUrlRedirect` and HTTPS `pathMatchers[].defaultUrlRedirect`: `stripQuery`, `redirectResponseCode`, `httpsRedirect` | [HttpRedirectAction schema](https://www.googleapis.com/discovery/v1/apis/compute/v1/rest?fields=schemas/HttpRedirectAction) and [URL Map API](https://docs.cloud.google.com/compute/docs/reference/rest/v1/urlMaps): defaults are `false`, `MOVED_PERMANENTLY_DEFAULT` (301), and `false`, respectively. Missing query stripping and response code match desired false/301. Missing HTTPS redirect **fails**, because this front end requires true. These paths are normalized separately; no same-named field elsewhere gets this treatment. |
| URL-map `hostRedirect`, `defaultService`, host rules, path matchers and their names/references | The same URL Map reference provides no fixed default equal to `antwars.ai` or this backend. The host, backend, exact arrays and parent redirect objects remain required where configured. Omitted host retains the request's host, not necessarily the apex, so it cannot replace the explicit host. |
| HTTP/HTTPS proxy `urlMap`, HTTPS `sslCertificates[]` | No default can stand in for the explicit map or certificate reference. Both remain required. See [TargetHttpProxy API](https://docs.cloud.google.com/compute/docs/reference/rest/v1/targetHttpProxies) and [TargetHttpsProxy API](https://docs.cloud.google.com/compute/docs/reference/rest/v1/targetHttpsProxies). The latter requires at least one certificate. An unset SSL policy already means no custom SSL policy and is accepted by the unchanged forbidden-policy guard. Other documented proxy defaults (QUIC NONE, proxyBind false, keep-alive 610 seconds, TLS early-data DISABLED) are **not fields this comparator checks**; this patch adds no new checks or settings for them. |
| Both forwarding rules `networkTier` | Missing means `PREMIUM`, matching this front end, according to the [global ForwardingRule API](https://docs.cloud.google.com/compute/docs/reference/rest/v1/globalForwardingRules). Normalize only this field on both rules. |
| Forwarding rules `IPAddress`, `IPProtocol`, `portRange`, `loadBalancingScheme`, `target`, `labels.app` | All remain explicit and strict. The [current API field descriptions](https://www.googleapis.com/discovery/v1/apis/compute/v1/rest?fields=schemas/ForwardingRule/properties(IPProtocol,networkTier,loadBalancingScheme,portRange)) do not document omitted-read defaults of TCP or EXTERNAL_MANAGED; no fixed default is the reserved address, ports 80/443, target proxies or app label. A creation default is not an API-read default. |

Optional absent/empty policies already accepted by the existing guards remain
accepted: NEG tag/mask and alternate targets, backend health checks/security
policy/IAP, URL-map extra routing fields, and HTTPS certificate-map/TLS/SSL
policies. The patch does not loosen how any explicit conflicting policy is
rejected. Metadata fields allowed but not compared gain no new meaning.

Tests cover the exact reported HTTP redirect shape, both redirect levels,
all nine matching-default field locations omitted together, read-only reruns
of all three phases, explicit wrong/null values at every defaulted location,
and missing required fields/nonmatching defaults across all resource kinds.
The operator must still run the reviewed head's describe phase against the
actual resources with **zero creates/updates/imports**, and the full test suite
must pass at that exact new head before it is merged. A parent-head full pass is
not a new-head full pass.

### DNS handoff and certificate

No IPv6 is reserved. Substitute only the IPv4 returned by reserve-ip:

```dns
antwars.ai. 300 IN A <reserved IPv4>
www.antwars.ai. 300 IN A <same reserved IPv4>
```

Add the apex A record first (game endpoint and certificate validation), then the
www A record (HTTPS www redirect and certificate validation). Both are direct,
unproxied records to the load balancer. Do not leave conflicting A/AAAA or CNAME
records for these names; whoever manages DNS reports conflicts before replacing
anything. No DNS-authorization CNAME, certificate map or Cloud Run domain mapping
is used. There is no registrar operation in this repository tooling.

CAA is **not mandatory when no CAA restrictions exist**. If CAA restricts issuers,
allow `pki.goog` or `letsencrypt.org`; Google recommends allowing both for
reliability. Whoever manages DNS checks apex, www and inherited restrictions.
Any needed CAA authorization precedes the A records. Existing CAA policy is not
assumed known. Source: [Google-managed SSL certificates, CAA section](https://docs.cloud.google.com/load-balancing/docs/ssl-certificates/google-managed-certs#caa).

Certificate provisioning needs both domains' DNS pointing to the reserved IP,
the certificate attached to the HTTPS proxy, and its 443 forwarding rule. The
DNS must be confirmed in place, and the operator must read `managed.status=ACTIVE`
and both domain statuses before the live checks. A read-only status command is:

```bash
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud --quiet --account "$ACCOUNT" --project "$PROJECT" compute ssl-certificates describe antwar-domain-cert --global --format='json(name,managed.status,managed.domainStatus,expireTime)'
```

[Google's provisioning guide](https://docs.cloud.google.com/load-balancing/docs/ssl-certificates/google-managed-certs)
explains the states. A successful creation command is not a serving certificate.

### Marginal cost

In a project with no other global forwarding rules, the first five global rules
together cost US$0.025/hour, so the two here add **US$18.25/month at 730 hours**.
Both rules share that tier; this is not US$18.25 per rule. Source:
[Cloud Load Balancing pricing](https://cloud.google.com/load-balancing/pricing).

- Reserved unattached IP: US$0.01/hour until a forwarding rule attaches it;
  attached to forwarding rules: US$0. Source:
  [VPC network pricing](https://cloud.google.com/vpc/network-pricing).
- Classic Google-managed certificate: US$0 (not a Certificate Manager
  allocation). No separate recurring NEG/backend/URL-map/
  proxy charge appears in the global external load-balancer pricing schedule.
- Traffic: US$0.008/GiB inbound processed and US$0.008/GiB outbound processed,
  plus Premium internet egress. Egress to Australia starts at US$0.19/GiB for
  the first 1,024 GiB; destination/volume changes that figure. Sources: the
  load-balancing and VPC pages above. Serverless egress is not charged again for
  requests through the NEG. Cloud Run compute charges continue unchanged.
- No CDN, Cloud Armor, API enablement or IAM grant is added. Figures are USD;
  billing currency conversion is not estimated.

### Outside-Google-Cloud checks

`.github/workflows/antwar-public-probe.yml` checks `https://antwars.ai` only, on
a schedule and by manual dispatch: it initializes MCP, lists tools without
calling them, and holds the MCP GET stream. Pushes run syntax checks only, so
publishing tooling cannot trigger a premature live check. It uses a
GitHub-hosted runner and refuses Google credential environment variables/files.

The domain comparison runs on the deploy host instead, as the last step of
`deploy.sh all`, once every service serves the new commit:
`node deploy/cloud-run/probe.mjs domain https://antwars.ai "$GAME_SERVICE_URL" 720`,
where `GAME_SERVICE_URL` is the game service's own run.app address from the
private config file. Its output goes to the deploy's stderr. A failure stops the
deploy non-zero with nothing rolled back; a skip is reported as `SKIPPED, not a
pass`; otherwise it reports `passed`. It needs the checkout's npm dependencies
(the MCP SDK) installed. It verifies TLS, page/rules,
path/query-preserving redirects and the run.app page, then MCP
initialize/listTools without join. No match is started or joined. These routes
exist both before and after entry-point main-match retirement.

The comparison reads `/watch/catalog` on both origins and selects the same public
lobby (matching lobby ID and start time). It opens that lobby's
`/watch/live/<lobbyId>` stream on the domain and run.app, alongside domain MCP
GET `/mcp`, concurrently for 720 seconds. Lobby identity replaces the old
slot-local sequence header, which watch proxies do not forward. If either
catalog has no public match, it reports `SKIPPED`, `status: "skipped"` and
`pass: null`: the comparison was not performed, not passed or failed. Page,
redirect and MCP checks still run. Malformed/unavailable catalogs, mismatched
nonempty catalogs and stream failures remain errors. The MCP session is pinged
separately, never joined, and deleted afterward. A missing spectator stream
(404) is failed coverage, not permission to start a match or redeploy.
No reconnect or workaround turns a closure into a pass. The deploy's output contains every completed SSE event/comment
arrival with UTC timestamp, monotonic time, bytes, fingerprint and spectator
tick (no session id or payload). SDK/session operations and header reads are
bounded; stream reads have their own 720-second deadline.

The server ticks at 100 ms; both idle spectator and MCP heartbeats are 15 seconds
(source read: `src/live/config.ts`, `src/live/snapshot.ts` and installed SDK
1.32.1 `server/sseKeepAlive.js`). The comparison reports raw matching-event
lag against the simultaneous direct stream, missing events, cadence excess,
maximum silence and closures. Its explicit 1,000 ms measurement tolerance is an
implementation choice. MCP keepalives have no server clock,
so their arrival cadence is measured, not absolute one-way latency. Any failed
comparison is returned with measurements; no workaround or integration follows.
The required 12-minute pass is not established by local tooling tests.

Hostname inspection found no Host/Origin allow-list in the public routes or MCP
transport construction, both at the reviewed head and the recorded serving build.
SDK 1.32.1 defaults `enableDnsRebindingProtection` to false. The separate
operator route's Origin rejection is unchanged and irrelevant to these probes.

### Remove only this front end

Remove only the two registrar A records added for this front end first, after
routing users back to run.app as authorized. Then delete the new resources in
this order. Do not use the earlier service teardown for a domain rollback.
Every call keeps the required account/project; deletion is a separate explicit
operator action, never an automatic failure handler.

```bash
gc() { CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud --quiet --account "$ACCOUNT" --project "$PROJECT" "$@"; }
gc compute forwarding-rules delete antwar-domain-http antwar-domain-https --global
gc compute target-http-proxies delete antwar-domain-http-proxy --global
gc compute target-https-proxies delete antwar-domain-https-proxy --global
gc compute url-maps delete antwar-domain-http-redirect antwar-domain-url-map --global
gc compute ssl-certificates delete antwar-domain-cert --global
gc compute backend-services delete antwar-domain-backend --global
gc compute network-endpoint-groups delete antwar-domain-neg --region=australia-southeast1
gc compute addresses delete antwar-domain-ip --global
```
