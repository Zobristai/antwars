/** Give WebGL a chance to restore the canvas before replacing the document. */
export const RESTORE_WAIT_MS = 5000;

export function watchContext(canvas: EventTarget, redraw: () => void, reload: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lost = (event: Event) => {
    event.preventDefault(); // Allow restoration.
    timer ??= setTimeout(reload, RESTORE_WAIT_MS);
  };
  const restored = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    redraw();
  };
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);
  return {
    get lost() { return timer !== undefined; },
    close() {
      clearTimeout(timer);
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
    },
  };
}
