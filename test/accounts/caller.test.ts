import { afterEach, describe, expect, it } from "vitest";
import { usernameClaimCaller, usernameClaimHeaderShape, usernameClaimLimitRuleFromEnv } from "../../src/accounts/caller.ts";
import { configureClientSource } from "../../src/server/clientSource.ts";

// Documentation addresses only (RFC 5737, RFC 3849).
const LBS = { ANTWAR_LOAD_BALANCER_ADDRESS: "192.0.2.10,2001:db8:ffff::a10" };

afterEach(() => configureClientSource({}));

describe("username claim rules", () => {
  it("defaults off and accepts only off or client", () => {
    expect(usernameClaimLimitRuleFromEnv({})).toBe("off");
    for (const rule of ["off", "client"] as const) {
      expect(usernameClaimLimitRuleFromEnv({ ANTWAR_USERNAME_CLAIM_LIMIT_RULE: rule })).toBe(rule);
    }
    for (const value of ["true", "last", "penultimate"]) {
      expect(() => usernameClaimLimitRuleFromEnv({ ANTWAR_USERNAME_CLAIM_LIMIT_RULE: value })).toThrow(/invalid ANTWAR_USERNAME_CLAIM_LIMIT_RULE: use off or client/);
    }
  });

  it("client counts the shared client source: last hop, or penultimate behind a load balancer; null when missing", () => {
    configureClientSource(LBS);
    expect(usernameClaimCaller({ "x-forwarded-for": "203.0.113.7,198.51.100.20" }, "client")).toBe("198.51.100.20");
    expect(usernameClaimCaller({ "x-forwarded-for": "203.0.113.7,198.51.100.20,192.0.2.10" }, "client")).toBe("198.51.100.20");
    expect(usernameClaimCaller({ "x-forwarded-for": "2001:db8:1:2::5,2001:db8:ffff::a10" }, "client")).toBe("2001:db8:1:2::/64");
    for (const headers of [{}, { "x-forwarded-for": "192.0.2.10" }, { "x-forwarded-for": "bad,192.0.2.10" }]) {
      expect(usernameClaimCaller(headers, "client")).toBeNull();
    }
  });

  it("client with no load balancer configured (a match slot) counts the last hop", () => {
    expect(usernameClaimCaller({ "x-forwarded-for": "203.0.113.7,198.51.100.20" }, "client")).toBe("198.51.100.20");
    expect(usernameClaimCaller({ "x-forwarded-for": "198.51.100.20," }, "client")).toBeNull();
  });

  it("does not validate any address when off", () => {
    for (const headers of [{}, { "x-forwarded-for": "garbage,," }, { "x-forwarded-for": ["", "::bad"] }]) {
      expect(usernameClaimCaller(headers, "off")).toBeUndefined();
    }
  });

  it("returns only the route class and whether the last hop is a load balancer, even for hostile Host/header values", () => {
    expect(usernameClaimHeaderShape({})).toEqual({ route: "missing", lastIsLoadBalancer: false });
    expect(usernameClaimHeaderShape({ host: "ANTWARS.AI:443", "x-forwarded-for": "203.0.113.7,192.0.2.10" })).toEqual({
      route: "antwars.ai", lastIsLoadBalancer: false,
    });
    configureClientSource(LBS);
    const behind = usernameClaimHeaderShape({ host: "antwars.ai", "x-forwarded-for": "203.0.113.7,192.0.2.10" });
    expect(behind).toEqual({ route: "antwars.ai", lastIsLoadBalancer: true });
    expect(usernameClaimHeaderShape({ host: "tag---service.region.run.app", "x-forwarded-for": "203.0.113.7" })).toEqual({
      route: "run.app", lastIsLoadBalancer: false,
    });
    expect(usernameClaimHeaderShape({ host: "antwars.ai.evil" }).route).toBe("other");
    const shape = usernameClaimHeaderShape({ host: "192.0.2.99", "x-forwarded-for": ["secret", "192.0.2.20,,"] });
    expect(shape).toEqual({ route: "other", lastIsLoadBalancer: false });
    expect(JSON.stringify([behind, shape])).not.toMatch(/192\.0\.2|203\.0\.113|secret/);
  });
});
