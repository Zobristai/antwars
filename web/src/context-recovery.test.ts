import { afterEach, expect, it, vi } from "vitest";
import { RESTORE_WAIT_MS, watchContext } from "./context-recovery.ts";

afterEach(() => vi.useRealTimers());

it("restores each loss once and does not reload a recovered board", () => {
  vi.useFakeTimers();
  const canvas = new EventTarget(), redraw = vi.fn(), reload = vi.fn();
  const context = watchContext(canvas, redraw, reload);
  for (let i = 1; i <= 2; i++) {
    expect(canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }))).toBe(false);
    vi.advanceTimersByTime(RESTORE_WAIT_MS - 1);
    expect(context.lost).toBe(true);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(context.lost).toBe(false);
    expect(redraw).toHaveBeenCalledTimes(i);
  }
  vi.advanceTimersByTime(RESTORE_WAIT_MS);
  expect(reload).not.toHaveBeenCalled();
});

it("reloads once after an unrestored loss, but never after leaving the page", () => {
  vi.useFakeTimers();
  const canvas = new EventTarget(), reload = vi.fn();
  const context = watchContext(canvas, vi.fn(), reload);
  canvas.dispatchEvent(new Event("webglcontextlost"));
  canvas.dispatchEvent(new Event("webglcontextlost"));
  vi.advanceTimersByTime(RESTORE_WAIT_MS);
  expect(reload).toHaveBeenCalledTimes(1);
  canvas.dispatchEvent(new Event("webglcontextrestored"));
  canvas.dispatchEvent(new Event("webglcontextlost"));
  context.close();
  vi.advanceTimersByTime(RESTORE_WAIT_MS);
  expect(reload).toHaveBeenCalledTimes(1);
});
