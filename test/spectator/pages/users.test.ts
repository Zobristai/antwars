import { resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ORIGIN, readFixtures, readSnapshot, serveSite } from "../../../web/render-check/serve.ts";
import { userHref } from "../../../web/src/ui/user-link.ts";

const dir = resolve(import.meta.dirname, "../../../web");
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "/opt/chrome-for-testing/chrome-linux64/chrome", args: ["--no-sandbox"] }); });
afterAll(async () => { await browser?.close(); });

it("links a numbered seat or agent to its username, never an unclaimed identity or house seat", () => {
  expect(userHref("sample-reed/wing #2")).toBe("/?page=users&user=sample-reed");
  for (const name of [null, "account:sample/wing", "antwars", "antwars/sample-model"]) expect(userHref(name)).toBeNull();
});

it("opens the requested row, sorts or closes it without reading again, and recovers with Refresh", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const fixtures = await readFixtures([resolve(dir, "render-check/users-loaded-fixture.json")]);
    const served = await serveSite(context, { dist: resolve(dir, "dist"), snapshot: await readSnapshot(), fixtures, rulesPage: () => "" });
    const page = await context.newPage(); let requests = 0;
    page.on("request", req => { if (new URL(req.url()).pathname === "/matches/users") requests++; });
    await page.goto(ORIGIN + "/?page=users&user=sample-wren");
    const entries = page.locator(".users-entry"), expanded = page.locator('.users-entry[aria-expanded="true"]');
    await expanded.waitFor(); expect(await expanded.textContent()).toBe("sample-wren");
    expect(await expanded.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
    expect(await entries.allTextContents()).toEqual(["sample-bee", "sample-fern", "sample-reed", "sample-wren"]);
    expect(await page.locator(".users-panel .users-replay").count()).toBe(5);
    expect(await page.locator(".users-panel .users-details section").first().textContent()).toContain("sample-wren/wing");
    await page.getByRole("combobox", { name: "Sort users" }).selectOption("0:-1");
    expect(await entries.first().textContent()).toBe("sample-wren");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    expect(await expanded.count()).toBe(0); await page.goBack(); await expanded.waitFor();
    expect(requests).toBe(1);
    await page.getByRole("button", { name: "Site pages" }).click();
    expect(await page.locator(".site-pages nav a").allTextContents()).toEqual(["Watch", "Matches", "Leaderboard", "Users"]);
    await page.keyboard.press("Escape"); expect(await page.locator(".site-pages-toggle").getAttribute("aria-expanded")).toBe("false");
    let fail = true;
    await page.route("**/matches/users", async route => fail ? route.fulfill({ status: 503, body: "" }) : route.fallback());
    await page.getByRole("button", { name: "Refresh" }).click(); await page.getByText("Refresh to try again.").waitFor();
    expect(await page.locator(".d1p-loaded").textContent()).toBe("");
    fail = false; await page.getByRole("button", { name: "Refresh" }).click(); await expanded.waitFor(); expect(requests).toBe(3);
    await page.goto(ORIGIN + "/?page=users&user=sample-absent"); await page.getByText(/No user named sample-absent/).waitFor();
    expect(await entries.count()).toBe(4); expect(await expanded.count()).toBe(0);
    expect(served.unanswered).toEqual([]);
  } finally { await context.close(); }
}, 20_000);
