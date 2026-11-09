#!/usr/bin/env bash
# An operator runs this file on the deploy host after review; the change's author does not run it.
#   bash deploy/cloud-run/domain.sh reserve-ip
#   bash deploy/cloud-run/domain.sh create-remaining
#   bash deploy/cloud-run/domain.sh describe
# Requires Node 24 and gcloud. No API enablement, credential/configuration change,
# Cloud Run write, build, deploy or DNS write. Failure stops without rollback.
# The gcloud account and project come from the private config file named by
# ANTWAR_DEPLOY_CONFIG (deploy/cloud-run/config.sh: ACCOUNT, PROJECT); it stops
# before any gcloud call, naming each one missing.
set -euo pipefail
# shellcheck source=deploy/cloud-run/config.sh
source "$(dirname "$0")/config.sh"
[[ $# == 1 && "$1" =~ ^(reserve-ip|create-remaining|describe)$ ]] || {
  echo 'usage: domain.sh reserve-ip|create-remaining|describe' >&2; exit 2;
}
load_deploy_config ACCOUNT PROJECT
DOMAIN_ACCOUNT="$ACCOUNT" DOMAIN_PROJECT="$PROJECT" node --input-type=module - "$1" <<'JS'
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIPv4 } from 'node:net';

const phase = process.argv[2];
const region = 'australia-southeast1';
const prefix = 'antwar-domain-';
const owner = 'antwars.ai frontend; app=antwar';
// Resources created by earlier versions of this script carry the marker after one
// leading word. Some of their kinds cannot change a description in place, so that
// older form stays accepted, by shape only. New resources get the marker alone.
const ownedDescription = (d) => typeof d === 'string'
  && (d === owner || (/^\S+ /.test(d) && d.slice(d.indexOf(' ') + 1) === owner));
const account = process.env.DOMAIN_ACCOUNT;
const project = process.env.DOMAIN_PROJECT;
const root = `https://www.googleapis.com/compute/v1/projects/${project}/`;
const stamp = (message) => console.log(new Date().toISOString(), message);
const gc = (...args) => {
  const command = ['--quiet', '--account', account, '--project', project, ...args, '--format=json'];
  stamp(`gcloud ${command.join(' ')}`);
  // No auth command or token. Only public configuration commands are logged.
  const text = execFileSync('gcloud', command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' } });
  return text.trim() === '' ? null : JSON.parse(text);
};
const ref = (kind, suffix, regional = false) => root + (regional ? `regions/${region}/` : 'global/') + kind + '/' + prefix + suffix;
const scope = (kind) => kind === 'network-endpoint-groups' ? [`--region=${region}`] : ['--global'];
const key = (kind, suffix) => `${kind}/${prefix}${suffix}`;
// Complete resource inventory. No implicit resources or IAM grants.
const resources = [
  ['addresses', 'ip'], ['network-endpoint-groups', 'neg'],
  ['backend-services', 'backend'], ['ssl-certificates', 'cert'],
  ['url-maps', 'url-map'], ['url-maps', 'http-redirect'],
  ['target-https-proxies', 'https-proxy'], ['target-http-proxies', 'http-proxy'],
  ['forwarding-rules', 'https'], ['forwarding-rules', 'http'],
];
const found = new Map();
for (const kind of new Set(resources.map(([kind]) => kind))) {
  const listScope = kind === 'network-endpoint-groups' ? [`--regions=${region}`] : ['--global'];
  // Read errors propagate: permission/API failures are never treated as absence.
  const rows = gc('compute', kind, 'list', ...listScope, '--filter=name~^antwar-domain-');
  if (!Array.isArray(rows)) throw new Error('invalid inventory response');
  for (const row of rows) {
    if (!resources.some(([k, suffix]) => k === kind && row.name === prefix + suffix)) {
      throw new Error(`unexpected resource in reserved namespace: ${row.name}`);
    }
    found.set(`${kind}/${row.name}`, row);
  }
}
const addressResource = found.get(key('addresses', 'ip'));
if (phase !== 'reserve-ip' && addressResource === undefined) throw new Error('run reserve-ip and return its DNS handoff first');
// Only documented defaults, scoped to the API resource and full field path.
// Sources and the complete checked-field audit are in TEARDOWN.md. CLI-only
// creation defaults are not assumed to be defaults of a read API response.
const redirectDefaults = [['stripQuery', false], ['redirectResponseCode', 'MOVED_PERMANENTLY_DEFAULT'], ['httpsRedirect', false]];
const apiDefaults = new Map([
  ['addresses', new Map([['addressType', 'EXTERNAL'], ['networkTier', 'PREMIUM']])],
  ['backend-services', new Map([['enableCDN', false]])],
  ['ssl-certificates', new Map([['type', 'SELF_MANAGED']])],
  ['url-maps', new Map(['defaultUrlRedirect', 'pathMatchers[].defaultUrlRedirect'].flatMap((path) =>
    redirectDefaults.map(([field, value]) => [`${path}.${field}`, value])))],
  ['forwarding-rules', new Map([['networkTier', 'PREMIUM']])],
]);
const contains = (actual, expected, defaults, path = '') => {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => contains(actual[i], v, defaults, path + '[]'));
  if (expected !== null && typeof expected === 'object') return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([k, v]) => {
    const field = path ? `${path}.${k}` : k;
    // Absence alone uses the documented default. Explicit null, wrong values,
    // missing parent objects and unrelated fields remain strict; no mutation.
    const value = Object.hasOwn(actual, k) ? actual[k] : defaults?.get(field);
    return contains(value, v, defaults, field);
  });
  return actual === expected;
};
const backendRef = ref('backendServices', 'backend');
const redirect = { hostRedirect: 'antwars.ai', httpsRedirect: true, redirectResponseCode: 'MOVED_PERMANENTLY_DEFAULT', stripQuery: false };
const httpsMap = { defaultService: backendRef, hostRules: [{ hosts: ['www.antwars.ai'], pathMatcher: 'www-redirect' }],
  pathMatchers: [{ name: 'www-redirect', defaultUrlRedirect: redirect }] };
const httpMap = { defaultUrlRedirect: redirect };
const expected = new Map([
  [key('addresses', 'ip'), { addressType: 'EXTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM', labels: { app: 'antwar' } }],
  [key('network-endpoint-groups', 'neg'), { networkEndpointType: 'SERVERLESS', cloudRun: { service: 'antwar' } }],
  [key('backend-services', 'backend'), { loadBalancingScheme: 'EXTERNAL_MANAGED', protocol: 'HTTP', backends: [{ group: ref('networkEndpointGroups', 'neg', true) }], enableCDN: false }],
  [key('ssl-certificates', 'cert'), { type: 'MANAGED', managed: { domains: ['antwars.ai', 'www.antwars.ai'] } }],
  [key('url-maps', 'url-map'), httpsMap], [key('url-maps', 'http-redirect'), httpMap],
  [key('target-https-proxies', 'https-proxy'), { urlMap: ref('urlMaps', 'url-map'), sslCertificates: [ref('sslCertificates', 'cert')] }],
  [key('target-http-proxies', 'http-proxy'), { urlMap: ref('urlMaps', 'http-redirect') }],
]);
if (addressResource !== undefined) {
  if (!isIPv4(addressResource.address)) throw new Error('expected reserved IPv4');
  for (const [suffix, port, type] of [['https', '443-443', 'targetHttpsProxies'], ['http', '80-80', 'targetHttpProxies']]) {
    expected.set(key('forwarding-rules', suffix), { IPAddress: addressResource.address, IPProtocol: 'TCP', portRange: port,
      loadBalancingScheme: 'EXTERNAL_MANAGED', networkTier: 'PREMIUM', target: ref(type, suffix + '-proxy'), labels: { app: 'antwar' } });
  }
}
// Preflight every existing object before any write. Reruns only skip verified
// configurations; they NEVER repair an earlier half-created or foreign object.
for (const [resource, config] of expected) {
  const actual = found.get(resource);
  if (actual === undefined) continue;
  const kind = resource.split('/')[0];
  // NEG create has no description flag. Its exact reserved name, SERVERLESS
  // type, antwar service and absence of a tag/mask are its ownership proof.
  const owns = kind === 'network-endpoint-groups' || ownedDescription(actual.description);
  if (!owns || !contains(actual, config, apiDefaults.get(kind))) throw new Error(`conflicting/incomplete existing resource: ${resource}; stop, do not repair`);
  const forbidden = {
    'network-endpoint-groups': ['appEngine', 'cloudFunction', 'network', 'subnetwork'],
    'backend-services': ['healthChecks', 'securityPolicy'],
    'url-maps': ['routeRules', 'defaultRouteAction', 'headerAction'],
    'target-https-proxies': ['certificateMap', 'serverTlsPolicy', 'sslPolicy'],
  }[kind] ?? [];
  if (forbidden.some((k) => Array.isArray(actual[k]) ? actual[k].length > 0 : Boolean(actual[k]))) throw new Error(`unexpected policy on ${resource}`);
  if (kind === 'backend-services' && actual.iap?.enabled) throw new Error('unexpected IAP');
  if (kind === 'network-endpoint-groups' && Object.keys(actual.cloudRun).some((k) => k !== 'service' && actual.cloudRun[k])) throw new Error('unexpected Cloud Run tag/mask');
  if (kind === 'url-maps') {
    const allowed = new Set(['name', 'description', 'id', 'kind', 'creationTimestamp', 'selfLink', 'fingerprint', ...Object.keys(config)]);
    if (Object.entries(actual).some(([k, v]) => !allowed.has(k) && (Array.isArray(v) ? v.length > 0 : Boolean(v)))) throw new Error('unexpected URL map routing field');
    if (actual.pathMatchers?.some((m) => Object.entries(m).some(([k, v]) => !['name', 'defaultUrlRedirect'].includes(k) && (Array.isArray(v) ? v.length > 0 : Boolean(v))))) throw new Error('unexpected path routing field');
  }
}
if (phase === 'describe') {
  for (const [kind, suffix] of resources) console.log(JSON.stringify(gc('compute', kind, 'describe', prefix + suffix, ...scope(kind))));
  process.exit(0);
}
const create = (kind, suffix, args, { label = false, urlMap } = {}) => {
  const name = prefix + suffix;
  if (found.has(key(kind, suffix))) { stamp(`verified existing; no write: ${name}`); return; }
  // INSERT-only: if another actor wins the name race, stop without updating it.
  const description = kind === 'network-endpoint-groups' ? [] : ['--description=' + owner];
  gc('compute', kind, 'create', name, ...scope(kind), ...description, ...args);
  // These commands finish ONLY an object created successfully immediately above.
  // Address/forwarding-rule create has no label flag. URL map create has no
  // redirect flag: reserve its name with INSERT before importing its config.
  if (label) gc('compute', kind, 'update', name, ...scope(kind), '--update-labels=app=antwar');
  if (urlMap !== undefined) {
    const work = mkdtempSync(join(tmpdir(), 'antwar-domain-'));
    try {
      const source = join(work, 'url-map.json');
      writeFileSync(source, JSON.stringify({ name, description: owner, ...urlMap }));
      gc('compute', kind, 'import', name, ...scope(kind), '--source=' + source);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
};
if (phase === 'reserve-ip') {
  create('addresses', 'ip', ['--ip-version=IPV4', '--network-tier=PREMIUM'], { label: true });
  const { address } = gc('compute', 'addresses', 'describe', prefix + 'ip', '--global');
  if (!isIPv4(address)) throw new Error('unexpected address');
  stamp('DNS HANDOFF NOW; unattached address costs US$0.01/hour until forwarding-rule attachment');
  console.log(`antwars.ai. 300 IN A ${address}\nwww.antwars.ai. 300 IN A ${address}`);
  process.exit(0);
}
create('network-endpoint-groups', 'neg', ['--network-endpoint-type=serverless', '--cloud-run-service=antwar']);
create('backend-services', 'backend', ['--load-balancing-scheme=EXTERNAL_MANAGED', '--protocol=HTTP', '--no-enable-cdn',
  '--network-endpoint-group=' + prefix + 'neg', '--network-endpoint-group-region=' + region]);
// No --timeout: serverless NEG backends have a fixed, non-configurable 60 minutes.
create('ssl-certificates', 'cert', ['--domains=antwars.ai,www.antwars.ai']);
create('url-maps', 'url-map', ['--default-service=' + prefix + 'backend'], { urlMap: httpsMap });
create('url-maps', 'http-redirect', ['--default-service=' + prefix + 'backend'], { urlMap: httpMap });
create('target-https-proxies', 'https-proxy', ['--url-map=' + prefix + 'url-map', '--global-url-map', '--ssl-certificates=' + prefix + 'cert', '--global-ssl-certificates']);
create('target-http-proxies', 'http-proxy', ['--url-map=' + prefix + 'http-redirect', '--global-url-map']);
for (const [suffix, port] of [['https', '443'], ['http', '80']]) {
  create('forwarding-rules', suffix, ['--load-balancing-scheme=EXTERNAL_MANAGED', '--network-tier=PREMIUM', '--ip-protocol=TCP',
    '--address=' + prefix + 'ip', '--global-address', '--ports=' + port,
    '--target-' + suffix + '-proxy=' + prefix + suffix + '-proxy', '--global-target-' + suffix + '-proxy'], { label: true });
}
stamp('created front end only; wait for DNS confirmation and managed certificate ACTIVE before probing');
JS
