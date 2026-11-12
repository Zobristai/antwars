// The Instrument deck top bar's brand: the approved emblem, decorative and bundled locally, stands before the
// unchanged text wordmark and credit. Visual evidence comes from the served build, never these tests.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EMBLEM_SRC, HOME_HREF, deckBrand } from "../../../web/src/ui/deck/brand.ts";
import { PAGE_COPY } from "../../../web/src/story.ts";

/** The approved cut of the antwars emblem (v2). */
const APPROVED_SHA256 = "c46495af967f926d10a2d21c3e213d453da70c00e1cc26b8b4344f079d66b075";

class FakeElement {
  className = "";
  textContent: string | null = null;
  src = "";
  alt = "";
  width = 0;
  height = 0;
  href = "";
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  constructor(readonly tagName: string) {}
  append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
}

const doc = { createElement: (tag: string) => new FakeElement(tag.toUpperCase()) } as unknown as Document;

describe("deck top bar brand", () => {
  it("links the decorative emblem and the unchanged wordmark home, with the credit beside the link", () => {
    const brand = deckBrand(doc) as unknown as FakeElement;
    expect(brand.tagName).toBe("P");
    expect(brand.className).toBe("d1-brand");
    expect(brand.children).toHaveLength(2);
    const [home, credit] = brand.children;
    // The home page is the landing at / with no query, never the match screen (?watch=1) or a recording.
    expect(HOME_HREF).toBe("/");
    expect(home.tagName).toBe("A");
    expect(home.className).toBe("d1-home");
    expect(home.href).toBe("/");
    expect(home.getAttribute("aria-label")).toBe("Antwars home");
    expect(home.getAttribute("aria-label")).toBe(PAGE_COPY.home);
    expect(home.children).toHaveLength(2);
    const [emblem, wordmark] = home.children;
    expect(emblem.tagName).toBe("IMG");
    expect(emblem.className).toBe("d1-emblem");
    expect(emblem.alt).toBe("");
    expect(emblem.getAttribute("aria-hidden")).toBe("true");
    expect(emblem.textContent).toBeNull();
    expect([emblem.width, emblem.height]).toEqual([36, 28]);
    expect(emblem.src).toBe(EMBLEM_SRC);
    expect(wordmark.className).toBe("d2-wordmark");
    expect(wordmark.textContent).toBe(PAGE_COPY.name);
    expect(credit.tagName).toBe("SPAN");
    expect(credit.className).toBe("d2-credit d1-top-credit");
    expect(credit.textContent).toBe(PAGE_COPY.credit);
  });

  it("bundles the approved emblem bytes locally", () => {
    const url = new URL(EMBLEM_SRC);
    expect(url.protocol).not.toMatch(/^https?:$/);
    expect(url.pathname.endsWith("/web/assets/brand/antwars-emblem.png")).toBe(true);
    const bytes = readFileSync(url);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(APPROVED_SHA256);
  });
});
