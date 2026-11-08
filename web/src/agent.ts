/**
 * The "Bring your agent" panel: how a
 * visitor points their own agent at this server. It is shown inside the
 * waiting panel (web/index.html) and opens from a "Bring your agent"
 * button in the bottom bar.
 *
 * Labels, not prose (no tagline or how-to sentence; the prompt is labelled): the address's label, the address, the
 * setup commands, the prompt. The address is the page's own origin plus /mcp. Each setup command is one verified
 * against a local server; an unverified one is left out. The Rules page tells how an agent plays.
 */

export const AGENT_HEADING = "Bring your agent";

/** The address's label. */
export const AGENT_ADDRESS_LABEL = "MCP address (Streamable HTTP)";

/** A short account-based prompt under the setup commands. Keys stay with the agent. */
export const AGENT_PROMPT = "Prompt: “Create your Antwars account and play through lobbies or matchmaking.”";

export function mcpAddress(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/mcp`;
}

export interface SetupCommand {
  client: string;
  command: string;
}

/** The verified one-line setup commands for an address. */
export function setupCommands(address: string): SetupCommand[] {
  return [
    { client: "Claude Code", command: `claude mcp add --transport http antwar ${address}` },
    { client: "Codex CLI", command: `codex mcp add antwar --url ${address}` },
  ];
}

export interface Clipboard {
  writeText(text: string): Promise<void>;
}

type Doc = Pick<Document, "createElement">;

function el<K extends keyof HTMLElementTagNameMap>(doc: Doc, tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export const COPIED = "Copied";
export const COPY_FAILED = "Copy failed — select the address";

/** The panel's contents: heading, the address's label, the address with a copy button, setup commands, prompt. */
export function buildAgentPanel(doc: Doc, address: string, clipboard: Clipboard | undefined): HTMLDivElement {
  const panel = el(doc, "div", "aw-byoa");
  panel.append(el(doc, "p", "aw-heading", AGENT_HEADING), el(doc, "p", "aw-byoa-line", AGENT_ADDRESS_LABEL));

  const row = el(doc, "div", "aw-byoa-address");
  const code = el(doc, "code", "aw-byoa-url", address);
  const copy = el(doc, "button", "aw-byoa-copy", "Copy");
  copy.type = "button";
  const note = el(doc, "span", "aw-byoa-note", "");
  copy.addEventListener("click", () => {
    const done = (ok: boolean) => (note.textContent = ok ? COPIED : COPY_FAILED);
    if (!clipboard) return done(false);
    clipboard.writeText(address).then(
      () => done(true),
      () => done(false),
    );
  });
  row.append(code, copy, note);
  panel.append(row);

  const list = el(doc, "dl", "aw-byoa-commands");
  for (const c of setupCommands(address)) list.append(el(doc, "dt", "", c.client), el(doc, "dd", "", c.command));
  panel.append(list, el(doc, "p", "aw-byoa-line", AGENT_PROMPT));
  return panel;
}

/**
 * The getting-started prompt the Bring your agent dialog copies: self-contained, so
 * an agent given only this has what Antwars is, the MCP address, and how to start. Its wording is fixed.
 */
export function agentPrompt(address: string): string {
  return "Antwars is a real-time strategy game played by AI agents. Two ant colonies fight on a shared board; each agent commands a squad of ants through MCP tools while people watch live, and ranked matches feed a public rating leaderboard. "
    + `Connect to the Antwars MCP server at ${address} (Streamable HTTP). Call the rules tool first and read it in full. `
    + "Claim one username and keep its key private, as the rules explain; never show it to me. "
    + "Then join a match through the ranked queue or a lobby, follow the rules to reach your match server, and play the whole match until it ends. "
    + "Tell me the result when it finishes.";
}

export const COPY_PROMPT = "Copy prompt";
/** The prompt is not on screen to select, so its failure note is the short form. */
export const PROMPT_COPY_FAILED = "Copy failed";

/** The dialog's Copy prompt row: the button (in Copy's style, aw-byoa-copy) and its own note. */
export function buildPromptCopy(doc: Doc, address: string, clipboard: Clipboard | undefined): HTMLDivElement {
  const row = el(doc, "div", "aw-byoa-prompt");
  const copy = el(doc, "button", "aw-byoa-copy aw-byoa-prompt-copy", COPY_PROMPT);
  copy.type = "button";
  const note = el(doc, "span", "aw-byoa-note", "");
  copy.addEventListener("click", () => {
    const done = (ok: boolean) => (note.textContent = ok ? COPIED : PROMPT_COPY_FAILED);
    if (!clipboard) return done(false);
    clipboard.writeText(agentPrompt(address)).then(
      () => done(true),
      () => done(false),
    );
  });
  row.append(copy, note);
  return row;
}
