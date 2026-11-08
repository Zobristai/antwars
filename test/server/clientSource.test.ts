import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clientSource, configureClientSource, lastHopIsLoadBalancer, loadBalancerAddressesFromEnv } from "../../src/server/clientSource.ts";
import { tempDir } from "./helpers.ts";

// Documentation addresses only (RFC 5737, RFC 3849).
const LB4 = "198.51.100.1";
const LB6 = "2001:db8:ffff::1";
const LBS = loadBalancerAddressesFromEnv({ ANTWAR_LOAD_BALANCER_ADDRESS: `${LB4}, ${LB6}` });
const xff = (value: string | string[]) => ({ "x-forwarded-for": value });

afterEach(() => configureClientSource({}));

describe("clientSource", () => {
  it("takes the last hop, never one the client wrote before it", () => {
    expect(clientSource(xff("192.0.2.20"))).toBe("192.0.2.20");
    for (const forged of ["203.0.113.7, ", "bad, ", "203.0.113.7, 203.0.113.8, ", ", "]) {
      expect(clientSource(xff(`${forged}192.0.2.20`))).toBe("192.0.2.20");
    }
    expect(clientSource(xff(["203.0.113.7", "192.0.2.20"]))).toBe("192.0.2.20");
  });

  it("takes the hop before the last only when the last is a configured load balancer", () => {
    expect(clientSource(xff(`192.0.2.20, ${LB4}`), LBS)).toBe("192.0.2.20");
    expect(clientSource(xff(`192.0.2.20, ${LB6}`), LBS)).toBe("192.0.2.20");
    // Compared canonically: another spelling of a configured address is still that address.
    expect(clientSource(xff("192.0.2.20, 2001:0db8:ffff:0:0:0:0:0001"), LBS)).toBe("192.0.2.20");
    expect(clientSource(xff(`192.0.2.20, ::ffff:${LB4}`), LBS)).toBe("192.0.2.20");
    // A last hop that is not a load balancer is the client, whatever precedes it.
    expect(clientSource(xff(`${LB4}, 192.0.2.20`), LBS)).toBe("192.0.2.20");
    // With no load balancer configured (match slots), the last hop is the client even if it is that address.
    expect(clientSource(xff(`192.0.2.20, ${LB4}`))).toBe(LB4);
  });

  it("is null when there is no client hop: no header, an invalid entry, or only a load balancer", () => {
    expect(clientSource({})).toBeNull();
    for (const value of ["", "bad", "192.0.2.20, bad", "192.0.2.20,", "fe80::1%eth0", "192.0.2.256"]) {
      expect(clientSource(xff(value), LBS)).toBeNull();
    }
    expect(clientSource(xff(LB4), LBS)).toBeNull();
    expect(clientSource(xff(`bad, ${LB4}`), LBS)).toBeNull();
    expect(clientSource(xff(`, ${LB6}`), LBS)).toBeNull();
  });

  it("uses IPv4 whole and groups IPv6 by its /64", () => {
    expect(clientSource(xff("192.0.2.20"))).not.toBe(clientSource(xff("192.0.2.21")));
    const a = clientSource(xff("2001:db8:1:2:aaaa::1"));
    expect(a).toBe("2001:db8:1:2::/64");
    expect(clientSource(xff("2001:0DB8:0001:0002:bbbb:cccc:dddd:eeee"))).toBe(a);
    expect(clientSource(xff("2001:db8:1:3::1"))).not.toBe(a);
    expect(clientSource(xff("::1"))).toBe("0:0:0:0::/64");
    expect(clientSource(xff("2001:db8::"))).toBe("2001:db8:0:0::/64");
    // IPv4-mapped IPv6 is the IPv4 address.
    expect(clientSource(xff("::ffff:192.0.2.20"))).toBe("192.0.2.20");
  });

  it("uses the addresses configured at startup by default", () => {
    expect(clientSource(xff(`192.0.2.20, ${LB4}`))).toBe(LB4);
    configureClientSource({ ANTWAR_LOAD_BALANCER_ADDRESS: LB4 });
    expect(clientSource(xff(`192.0.2.20, ${LB4}`))).toBe("192.0.2.20");
  });

  it("reads an unset or empty list as none and refuses an invalid entry without repeating it", () => {
    expect(loadBalancerAddressesFromEnv({}).size).toBe(0);
    expect(loadBalancerAddressesFromEnv({ ANTWAR_LOAD_BALANCER_ADDRESS: " " }).size).toBe(0);
    expect([...LBS].sort()).toEqual([LB4, LB6].sort());
    for (const value of [`${LB4},`, "not-an-address", `${LB4}, 203.0.113.300`, "fe80::1%eth0"]) {
      let message = "";
      try {
        loadBalancerAddressesFromEnv({ ANTWAR_LOAD_BALANCER_ADDRESS: value });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/^invalid ANTWAR_LOAD_BALANCER_ADDRESS: entry \d+ is not an IPv4 or IPv6 address$/);
    }
  });

  it("npm start refuses to start on an invalid entry, without printing it", () => {
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ["ANTWAR_RULES", "ANTWAR_PLAYERS", "ANTWAR_SLOT", "ANTWAR_PUBLIC_URL", "ANTWAR_STORE_NAMESPACE"]) delete base[name];
    const r = spawnSync(process.execPath, ["--import", "./src/ts-resolve.mjs", "src/main.ts"], {
      cwd: join(import.meta.dirname, "..", ".."),
      env: { ...base, ANTWAR_LOAD_BALANCER_ADDRESS: `${LB4}, 203.0.113.300`, PORT: "0", DATA_DIR: tempDir() },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/antwar refused to start: invalid ANTWAR_LOAD_BALANCER_ADDRESS: entry 2 /);
    expect(r.stdout + r.stderr).not.toContain("203.0.113");
    expect(r.stdout + r.stderr).not.toContain(LB4);
  }, 30_000);
});

describe("lastHopIsLoadBalancer", () => {
  it("is true only when the last entry is a configured load-balancer address", () => {
    expect(lastHopIsLoadBalancer(xff(`192.0.2.20, ${LB4}`), LBS)).toBe(true);
    expect(lastHopIsLoadBalancer(xff(`2001:db8:1:2::5, 2001:0db8:ffff:0:0:0:0:0001`), LBS)).toBe(true);
    expect(lastHopIsLoadBalancer(xff(["192.0.2.20", LB4]), LBS)).toBe(true);
    // Unconfigured last hop, including a configured address earlier in the chain.
    expect(lastHopIsLoadBalancer(xff("192.0.2.20"), LBS)).toBe(false);
    expect(lastHopIsLoadBalancer(xff(`${LB4}, 192.0.2.20`), LBS)).toBe(false);
  });

  it("is false with no header, an invalid last entry or an empty list", () => {
    expect(lastHopIsLoadBalancer({}, LBS)).toBe(false);
    for (const value of [`${LB4},`, `${LB4}, bad`, "", "fe80::1%eth0"]) expect(lastHopIsLoadBalancer(xff(value), LBS)).toBe(false);
    expect(lastHopIsLoadBalancer(xff(`192.0.2.20, ${LB4}`), new Set())).toBe(false);
  });

  it("uses the addresses configured at startup by default, none until configured", () => {
    expect(lastHopIsLoadBalancer(xff(`192.0.2.20, ${LB4}`))).toBe(false);
    configureClientSource({ ANTWAR_LOAD_BALANCER_ADDRESS: LB4 });
    expect(lastHopIsLoadBalancer(xff(`192.0.2.20, ${LB4}`))).toBe(true);
  });
});
