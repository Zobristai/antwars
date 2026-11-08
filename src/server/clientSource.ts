/// <reference types="node" />
import { isIP } from "node:net";
import { canonicalAddress } from "../accounts/caller.js";

/**
 * The one client-address rule every per-source limit uses:
 * the last X-Forwarded-For entry, which Google's frontend appends and the client
 * cannot write, or the entry before it only when the last is one of this
 * deployment's configured load-balancer addresses (ANTWAR_LOAD_BALANCER_ADDRESS,
 * empty on match slots). Entries a client writes ahead of those are never read.
 * IPv4 is used whole; IPv6 is grouped by its /64, which one subscriber usually
 * holds whole. null means no client hop: no header, an invalid entry, or only a
 * load-balancer address; each limiter maps null to its own shared key.
 *
 * Never log, echo or return the result to a client: it is a client address.
 */
type Headers = Readonly<Record<string, string | string[] | undefined>>;

const NO_LOAD_BALANCERS: ReadonlySet<string> = new Set();
let configured: ReadonlySet<string> = NO_LOAD_BALANCERS;

/**
 * The configured load-balancer addresses, canonical, from a comma list of IPv4
 * and IPv6 addresses; unset or empty is none. Throws on any invalid entry, so a
 * mistyped address fails startup instead of making every entry service caller
 * the load balancer. The message never repeats the value.
 */
export function loadBalancerAddressesFromEnv(env: Readonly<Record<string, string | undefined>>): ReadonlySet<string> {
  const value = env.ANTWAR_LOAD_BALANCER_ADDRESS ?? "";
  if (value.trim() === "") return NO_LOAD_BALANCERS;
  const addresses = new Set<string>();
  for (const [index, entry] of value.split(",").entries()) {
    const address = canonicalAddress(entry);
    if (address === undefined) throw new Error(`invalid ANTWAR_LOAD_BALANCER_ADDRESS: entry ${index + 1} is not an IPv4 or IPv6 address`);
    addresses.add(address);
  }
  return addresses;
}

/** Read and validate ANTWAR_LOAD_BALANCER_ADDRESS once at startup; clientSource(headers) then uses it. */
export function configureClientSource(env: Readonly<Record<string, string | undefined>>): void {
  configured = loadBalancerAddressesFromEnv(env);
}

/** An IPv6 address's /64, as the first four groups of its full form. */
function ipv6Prefix64(address: string): string {
  const gap = address.indexOf("::");
  const left = gap === -1 ? address.split(":") : address.slice(0, gap).split(":").filter((g) => g !== "");
  const right = gap === -1 ? [] : address.slice(gap + 2).split(":").filter((g) => g !== "");
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/** The one X-Forwarded-For read: its entries and the last one, canonical (undefined when invalid); undefined with no header. */
function lastHop(headers: Headers): { readonly chain: readonly string[]; readonly last: string | undefined } | undefined {
  const value = headers["x-forwarded-for"];
  if (value === undefined) return undefined;
  // Keep empty elements: dropping them would move the right-relative hops.
  const chain = (Array.isArray(value) ? value.join(",") : value).split(",");
  return { chain, last: canonicalAddress(chain[chain.length - 1]!) };
}

/**
 * Whether the last X-Forwarded-For entry is a configured load-balancer address: false with no header,
 * an invalid last entry or an empty list. Only the boolean leaves this module, never an address
 * (the claim header-shape log carries it).
 */
export function lastHopIsLoadBalancer(headers: Headers, loadBalancers: ReadonlySet<string> = configured): boolean {
  const last = lastHop(headers)?.last;
  return last !== undefined && loadBalancers.has(last);
}

/** The client's source key, or null when the request carries no client hop. See the module comment. */
export function clientSource(headers: Headers, loadBalancers: ReadonlySet<string> = configured): string | null {
  const read = lastHop(headers);
  if (read === undefined) return null;
  let hop = read.last;
  if (hop !== undefined && loadBalancers.has(hop)) {
    const before = read.chain[read.chain.length - 2];
    hop = before === undefined ? undefined : canonicalAddress(before);
  }
  if (hop === undefined) return null;
  return isIP(hop) === 6 ? ipv6Prefix64(hop) : hop;
}
