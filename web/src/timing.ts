/**
 * Real-time source for the bench timings only; it never feeds animation.
 * During capture Playwright's page.clock replaces performance.now(), so the
 * capture tool saves performance.now.bind(performance) as
 * window.__antwarRealNow in an init script registered BEFORE page.clock.install.
 * A handle saved after install is silently frozen, so this checks that the
 * source advances across a short spin and refuses otherwise.
 */
declare global {
  interface Window {
    __antwarRealNow?: () => number;
  }
}

export type RealNow = () => number;

/** Elapsed-work instrumentation only (also available in a worker). Never a source of animation time. */
export const measurementNow: RealNow = () => performance.now();

/** Forced GPU completion is for pixel capture/explicit GPU measurement, never ordinary frame or JS timing. */
export function gpuReadback(params: URLSearchParams): boolean {
  return params.get("gpuTiming") === "1" || (params.has("capture") && params.get("gpuTiming") !== "0");
}

export function realTimeSource(): RealNow {
  const now = window.__antwarRealNow;
  if (typeof now !== "function") throw new Error("timing: no real-time source (window.__antwarRealNow) was installed before the clock");
  const start = now();
  let spins = 0;
  while (now() - start < 1 && spins < 50_000_000) spins++;
  if (!(now() - start >= 1)) throw new Error("timing: real-time source does not advance; it was saved after page.clock.install");
  return now;
}
