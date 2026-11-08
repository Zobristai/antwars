/** Observer-only result/reconnect checks; no served application or server changes. */
import type { Page } from "playwright-core";
import { TICK_MS } from "../../src/live/snapshot.ts";
import { RESULT_BEAT_MS } from "../src/buffer.ts";
import { LIVE_BUFFER_MS } from "../src/playout.ts";
import { until, type FinalResultWrite } from "./spectator-world.ts";

export const DESIGNED_RESULT_DELAY_MS = LIVE_BUFFER_MS + TICK_MS + RESULT_BEAT_MS;
export const RESULT_DEADLINE_SLACK_MS = 1000;

type ViolationSummary = { violationCount: number; firstViolation?: string; lastViolation?: string };
type StreamReceipt = { connection: number; path: string; receivedAt: number; characters: number };
type Probe = {
  receipts: StreamReceipt[];
  start(): { at: number; connection: number };
  interrupt(): void;
  finish(): { samples: number; violations: string[] } & ViolationSummary;
};
declare global { interface Window { __spectatorReconnect: Probe; } }

/** Wrap the real EventSource only to observe receipts and simulate a closed connection.
 * Its normal onerror/retry path, decoder, worker and playback remain the product's own.
 */
export async function observeResultReconnect(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeSource = window.EventSource;
    const streams: { source: EventSource; path: string; connection: number }[] = [];
    const receipts: StreamReceipt[] = [];
    window.EventSource = class extends NativeSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        const path = new URL(String(url), location.href).pathname;
        if (!path.startsWith("/watch/live/")) return;
        const connection = streams.length + 1;
        streams.push({ source: this, path, connection });
        this.addEventListener("message", event => {
          receipts.push({ connection, path, receivedAt: Date.now(), characters: event.data.length });
        });
      }
    };
    let active = false, samples = 0, violations: string[] = [];
    let violationCount = 0, firstViolation: string | undefined, lastViolation: string | undefined;
    // The result card and the board's area (the host's, window.__antwar.boardArea()).
    const selectors = [".d1-result", "board area"];
    const geometry = () => {
      const element = document.querySelector<HTMLElement>(".d1-result");
      const rect = element?.getBoundingClientRect();
      const area = window.__antwar?.boardArea();
      return [rect ? [rect.x, rect.y, rect.width, rect.height] : null, area ? [area.x0, area.y0, area.x1 - area.x0, area.y1 - area.y0] : null];
    };
    let baseline: (number[] | null)[] = [];
    let panelAtStart: HTMLElement | null = null;
    let initialReveal: Animation | null = null;
    let revealSettled = true;
    let lastRevealTime = 0;
    // Offsets do not include the card's reveal transform. Retain each offset
    // ancestor too: a parent moving/reparenting must not disappear into a new baseline.
    const layout = (panel: HTMLElement | null) => {
      const chain: { node: HTMLElement; values: number[] }[] = [];
      for (let node = panel; node; node = node.offsetParent as HTMLElement | null) {
        chain.push({ node, values: [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight, node.scrollLeft, node.scrollTop] });
      }
      return chain;
    };
    let layoutBaseline: ReturnType<typeof layout> = [];
    const fail = (message: string) => {
      const violation = `${message} at ${new Date().toISOString()}`;
      violationCount++;
      firstViolation ??= violation;
      lastViolation = violation;
      if (violations.length < 20) violations.push(violation);
    };
    document.addEventListener("animationstart", event => {
      if (active && event.target === panelAtStart && (revealSettled || (event as AnimationEvent).animationName !== "aw-reveal")) fail("Result animation restarted");
    });
    const record = () => {
      if (!active) return;
      samples++;
      const panel = document.querySelector<HTMLElement>(".d1-result");
      const ratings = document.querySelector<HTMLElement>(".d1-ratings");
      const visible = panel && ratings && !panel.hidden && panel.getBoundingClientRect().height > 0
        && getComputedStyle(panel).visibility !== "hidden" && getComputedStyle(panel).display !== "none";
      if (!visible) fail("Result hidden");
      const currentLayout = layout(panel);
      if (panel !== panelAtStart || currentLayout.length !== layoutBaseline.length || currentLayout.some((entry, i) => {
        const before = layoutBaseline[i]!;
        return entry.node !== before.node || entry.values.some((value, j) => Math.abs(value - before.values[j]!) > 0.5);
      })) fail("Result layout moved");
      const animations = panel?.getAnimations() ?? [];
      if (animations.some(animation => (revealSettled || animation !== initialReveal) && animation.playState !== "finished")) fail("Unexpected result animation");
      const current = geometry();
      if (!revealSettled && initialReveal) {
        const time = Number(initialReveal.currentTime ?? 0);
        if (time < lastRevealTime || initialReveal.playbackRate !== 1) fail("Result reveal restarted or changed rate");
        lastRevealTime = time;
        if (initialReveal.playState === "finished") {
          if (panel && getComputedStyle(panel).transform !== "none") fail("Result transform remained after reveal");
          // This is the ONLY baseline update, while intrinsic layout has stayed
          // under observation since start(). Reconnect never resets this state.
          baseline[0] = current[0]!;
          revealSettled = true;
        } else if (initialReveal.playState !== "running" && !initialReveal.pending) fail("Result reveal interrupted");
      }
      current.forEach((rect, i) => {
        if (i === 0 && !revealSettled) return; // Only the known initial transform is exempt.
        const before = baseline[i];
        if ((rect === null) !== (before === null) || (rect && before && rect.some((value, j) => Math.abs(value - before[j]!) > 0.5))) {
          fail(`${selectors[i]} moved`);
        }
      });
    };
    const loop = () => { record(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    new MutationObserver(record).observe(document, { subtree: true, attributes: true, childList: true });
    window.__spectatorReconnect = {
      receipts,
      start() {
        samples = 0; violations = []; violationCount = 0; firstViolation = lastViolation = undefined; baseline = geometry();
        if (baseline.some(rect => rect === null)) throw new Error("Missing result/board area geometry");
        panelAtStart = document.querySelector<HTMLElement>(".d1-result");
        layoutBaseline = layout(panelAtStart);
        const animations = panelAtStart!.getAnimations();
        initialReveal = animations.find(animation => "animationName" in animation && animation.animationName === "aw-reveal"
          && animation.playState === "running" && animation.effect?.getTiming().duration === 520 && animation.playbackRate === 1) ?? null;
        revealSettled = initialReveal === null;
        lastRevealTime = Number(initialReveal?.currentTime ?? 0);
        active = true; record();
        return { at: Date.now(), connection: streams.at(-1)?.connection ?? 0 };
      },
      interrupt() {
        const stream = streams.at(-1);
        if (!stream) throw new Error("No watch stream to interrupt");
        stream.source.close();
        stream.source.dispatchEvent(new Event("error"));
      },
      finish() {
        record();
        if (!revealSettled) fail("Result reveal never settled");
        active = false;
        return { samples, violations, violationCount, firstViolation, lastViolation };
      },
    };
  });
}

export type ReconnectCheck = {
  kind: "automatic-30s" | "connection-recovery";
  startedAt: string;
  fullResultReceivedAt?: string;
  ownerFullResultWrittenAt?: string;
  receivedCharacters?: number;
  samples?: number;
  violations?: string[];
  violationCount?: number;
  firstViolation?: string;
  lastViolation?: string;
};

/** The public selected lobby is already ended and the card visible. Natural reopen
 * is tested on both renderers; connection recovery additionally covers boardless.
 * Retain failures as well as passes in the caller's report.
 */
export async function checkResultReconnect(page: Page, kind: ReconnectCheck["kind"], checks: ReconnectCheck[], writes: readonly FinalResultWrite[], match: { lobbyId: string; origin: string }): Promise<void> {
  const cursor = writes.length;
  const start = await page.evaluate(() => window.__spectatorReconnect.start());
  const check: ReconnectCheck = { kind, startedAt: new Date(start.at).toISOString() }; checks.push(check);
  try {
    if (kind === "connection-recovery") await page.evaluate(() => window.__spectatorReconnect.interrupt());
    await until(async () => {
      const receipt = await page.evaluate(({ after, at }) => window.__spectatorReconnect.receipts.find(value => value.connection > after && value.receivedAt >= at), { after: start.connection, at: start.at });
      const write = writes.slice(cursor).find(value => value.full && value.lobbyId === match.lobbyId && value.origin === match.origin);
      if (!receipt || !write) return false;
      if (receipt.path !== `/watch/live/${match.lobbyId}` || receipt.receivedAt < write.writtenAt) throw new Error("Reconnect receipt does not match the ended lobby's owner write");
      check.ownerFullResultWrittenAt = new Date(write.writtenAt).toISOString();
      check.fullResultReceivedAt = new Date(receipt.receivedAt).toISOString();
      check.receivedCharacters = receipt.characters;
      return true;
    }, 45_000);
    // Keep observing beyond the former four-second replay, not merely the
    // event callback before the worker has decoded and applied the snapshot.
    await page.waitForTimeout(DESIGNED_RESULT_DELAY_MS + RESULT_DEADLINE_SLACK_MS);
  } finally {
    Object.assign(check, await page.evaluate(() => window.__spectatorReconnect.finish()));
  }
  if (!check.samples || check.violationCount || check.violations?.length) throw new Error(`${kind}: reconnect changed result visibility/layout: ${check.violationCount} violations; first: ${check.firstViolation}; last: ${check.lastViolation}`);
}
