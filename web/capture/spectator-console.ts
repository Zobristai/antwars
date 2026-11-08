import type { Page } from "playwright-core";

/** Keep the most recent console evidence, redacting before truncation so even a
 * secret that crosses the retained boundary cannot leak a prefix into a report.
 * No page-side state, timers or navigation behavior are changed.
 */
export function captureConsole(page: Pick<Page, "on">, redact: (value: unknown) => string) {
  const report = { entries: [] as { at: string; type: string; text: string; truncated: boolean }[], dropped: 0 };
  page.on("console", message => {
    const text = redact(message.text());
    if (report.entries.length === 200) { report.entries.shift(); report.dropped++; }
    report.entries.push({ at: new Date().toISOString(), type: message.type(), text: text.slice(0, 2000), truncated: text.length > 2000 });
  });
  return report;
}
