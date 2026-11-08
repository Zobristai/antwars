/// <reference types="node" />
import { isIP } from "node:net";
import { clientSource, lastHopIsLoadBalancer } from "../server/clientSource.js";

/**
 * Which caller a username claim is counted against.
 *   off     no claim limit (the default; the local route needs no configuration)
 *   client  the shared client source, server/clientSource.ts, used as it is
 */
export type UsernameClaimLimitRule = "off" | "client";
type Headers = Readonly<Record<string, string | string[] | undefined>>;

export function usernameClaimLimitRuleFromEnv(env: Readonly<Record<string, string | undefined>>): UsernameClaimLimitRule {
  const value = env.ANTWAR_USERNAME_CLAIM_LIMIT_RULE ?? "off";
  if (value === "off" || value === "client") return value;
  throw new Error("invalid ANTWAR_USERNAME_CLAIM_LIMIT_RULE: use off or client");
}

function route(headers: Headers): "run.app" | "antwars.ai" | "other" | "missing" {
  const host = headers.host;
  if (host === undefined) return "missing";
  if (typeof host !== "string") return "other";
  if (/^(?:www\.)?antwars\.ai(?::[0-9]+)?$/i.test(host)) return "antwars.ai";
  if (/^(?:[a-z0-9-]+\.)*run\.app(?::[0-9]+)?$/i.test(host)) return "run.app";
  return "other";
}

/** Shape only: never return raw headers, addresses, hashes or user input. */
export function usernameClaimHeaderShape(headers: Headers) {
  // The post-deploy check reads antwars.ai with true and run.app with false.
  return { route: route(headers), lastIsLoadBalancer: lastHopIsLoadBalancer(headers) };
}

/** One address in canonical form (IPv4-mapped IPv6 as IPv4), or undefined when not an unscoped IP address. Shared with clientSource. */
export function canonicalAddress(input: string): string | undefined {
  const address = input.trim();
  if (address.includes("%")) return undefined; // not an unscoped network address
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return undefined;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** undefined means OFF; null means no client hop, refused caller_unavailable. */
export function usernameClaimCaller(headers: Headers, rule: UsernameClaimLimitRule): string | null | undefined {
  return rule === "off" ? undefined : clientSource(headers);
}
