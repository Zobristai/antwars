/**
 * The "Bring your agent" panel carries
 * its two lines word for word, the page's own origin plus /mcp with
 * a working copy button, and the verified setup commands; it is shown in the
 * waiting panel and opens from a "Bring your agent" button in the bottom bar.
 *
 * The repository has no DOM library, so a minimal fake document stands in for
 * the few element operations web/src/agent.ts uses.
 */
import { describe, expect, it } from "vitest";
import { AGENT_ADDRESS_LABEL, AGENT_HEADING, AGENT_PROMPT, COPIED, COPY_FAILED, COPY_PROMPT, PROMPT_COPY_FAILED, agentPrompt, buildAgentPanel, buildPromptCopy, mcpAddress, setupCommands, type Clipboard } from "../../web/src/agent.ts";

class FakeElement {
  className = "";
  hidden = false;
  type = "";
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  private text = "";
  private listeners = new Map<string, (() => void)[]>();
  constructor(readonly tagName: string) {}
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click() {
    for (const fn of this.listeners.get("click") ?? []) fn();
  }
  /** Every descendant (depth first) with the class. */
  all(cls: string): FakeElement[] {
    return this.children.flatMap((c) => [...(c.className.split(" ").includes(cls) ? [c] : []), ...c.all(cls)]);
  }
  one(cls: string): FakeElement {
    const found = this.all(cls);
    expect(found, `.${cls}`).toHaveLength(1);
    return found[0]!;
  }
  /** Text of each element child, in order. */
  texts(): string[] {
    return this.children.map((c) => c.textContent);
  }
}

const doc = { createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
const asEl = (e: unknown) => e as FakeElement;
const flush = () => new Promise((r) => setTimeout(r, 0));

const ORIGIN = "https://antwar.example";
const ADDRESS = "https://antwar.example/mcp";

describe("the panel's copy and address", () => {
  it("labels the panel's parts, with no tagline or how-to sentence (once two lines)", () => {
    expect(AGENT_HEADING).toBe("Bring your agent");
    expect(AGENT_ADDRESS_LABEL).toBe("MCP address (Streamable HTTP)");
  });

  it("builds the address from the page's own origin plus /mcp", () => {
    expect(mcpAddress("https://antwar.example")).toBe("https://antwar.example/mcp");
    expect(mcpAddress("http://localhost:8080")).toBe("http://localhost:8080/mcp");
    expect(mcpAddress("http://203.0.113.7:18930/")).toBe("http://203.0.113.7:18930/mcp");
  });

  it("carries the prompt's words exactly, labelled", () => {
    expect(AGENT_PROMPT).toBe("Prompt: “Create your Antwars account and play through lobbies or matchmaking.”");
  });

  it("shows heading, the address's label, address with Copy, the setup commands, then the prompt, in that order", () => {
    const panel = asEl(buildAgentPanel(doc, ADDRESS, undefined));
    expect(panel.children).toHaveLength(5);
    const [heading, line1, row, commands, prompt] = panel.children;
    expect(prompt!.textContent).toBe(AGENT_PROMPT);
    expect(heading!.textContent).toBe(AGENT_HEADING);
    expect(line1!.textContent).toBe(AGENT_ADDRESS_LABEL);
    expect(row!.one("aw-byoa-url").textContent).toBe(ADDRESS);
    expect(row!.one("aw-byoa-copy").textContent).toBe("Copy");
    expect(commands!.texts()).toEqual(setupCommands(ADDRESS).flatMap((c) => [c.client, c.command]));
  });

  it("shows only the verified Claude Code and Codex CLI one-liners, each for this address", () => {
    expect(setupCommands(ADDRESS)).toEqual([
      { client: "Claude Code", command: "claude mcp add --transport http antwar https://antwar.example/mcp" },
      { client: "Codex CLI", command: "codex mcp add antwar --url https://antwar.example/mcp" },
    ]);
  });
});

describe("the copy button", () => {
  it("writes exactly the address to the clipboard and says so", async () => {
    const written: string[] = [];
    const clipboard: Clipboard = { writeText: async (t) => void written.push(t) };
    const panel = asEl(buildAgentPanel(doc, ADDRESS, clipboard));
    panel.one("aw-byoa-copy").click();
    await flush();
    expect(written).toEqual([ADDRESS]);
    expect(panel.one("aw-byoa-note").textContent).toBe(COPIED);
  });

  it("says when copying failed, or when there is no clipboard", async () => {
    const refused = asEl(buildAgentPanel(doc, ADDRESS, { writeText: () => Promise.reject(new Error("denied")) }));
    refused.one("aw-byoa-copy").click();
    await flush();
    expect(refused.one("aw-byoa-note").textContent).toBe(COPY_FAILED);
    const none = asEl(buildAgentPanel(doc, ADDRESS, undefined));
    none.one("aw-byoa-copy").click();
    expect(none.one("aw-byoa-note").textContent).toBe(COPY_FAILED);
  });
});

// The dialog's Copy prompt copies the fixed prompt, word for word, with the address.
const PROMPT = "Antwars is a real-time strategy game played by AI agents. Two ant colonies fight on a shared board; each agent commands a squad of ants through MCP tools while people watch live, and ranked matches feed a public rating leaderboard. Connect to the Antwars MCP server at https://antwar.example/mcp (Streamable HTTP). Call the rules tool first and read it in full. Claim one username and keep its key private, as the rules explain; never show it to me. Then join a match through the ranked queue or a lobby, follow the rules to reach your match server, and play the whole match until it ends. Tell me the result when it finishes.";

describe("the Copy prompt button", () => {
  it("carries the getting-started prompt word for word, with the page's address", () => {
    expect(agentPrompt(ADDRESS)).toBe(PROMPT);
    expect(agentPrompt(mcpAddress("http://localhost:8080"))).toContain(" at http://localhost:8080/mcp (Streamable HTTP).");
  });

  it("is labelled Copy prompt, in Copy's cyan style, and writes exactly the prompt to the clipboard", async () => {
    const written: string[] = [];
    const row = asEl(buildPromptCopy(doc, ADDRESS, { writeText: async (t) => void written.push(t) }));
    const button = row.one("aw-byoa-prompt-copy");
    expect(button.textContent).toBe(COPY_PROMPT);
    expect(COPY_PROMPT).toBe("Copy prompt");
    // The class the dialog's cyan Copy rule selects (deck-key-cyan.test.ts pins that rule).
    expect(button.className.split(" ")).toContain("aw-byoa-copy");
    expect(button.type).toBe("button");
    button.click();
    await flush();
    expect(written).toEqual([PROMPT]);
    expect(row.one("aw-byoa-note").textContent).toBe(COPIED);
  });

  it("says Copy failed when copying is refused or there is no clipboard", async () => {
    expect(PROMPT_COPY_FAILED).toBe("Copy failed");
    const refused = asEl(buildPromptCopy(doc, ADDRESS, { writeText: () => Promise.reject(new Error("denied")) }));
    refused.one("aw-byoa-prompt-copy").click();
    await flush();
    expect(refused.one("aw-byoa-note").textContent).toBe(PROMPT_COPY_FAILED);
    const none = asEl(buildPromptCopy(doc, ADDRESS, undefined));
    none.one("aw-byoa-prompt-copy").click();
    expect(none.one("aw-byoa-note").textContent).toBe(PROMPT_COPY_FAILED);
  });

  it("is not in the legacy panel, which keeps its old prompt line", () => {
    const panel = asEl(buildAgentPanel(doc, ADDRESS, undefined));
    expect(panel.all("aw-byoa-prompt-copy")).toHaveLength(0);
    expect(panel.textContent).toContain(AGENT_PROMPT);
    expect(panel.textContent).not.toContain(PROMPT);
  });
});
