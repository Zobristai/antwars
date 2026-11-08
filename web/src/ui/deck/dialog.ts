// The Instrument deck: Bring your agent as one button and a native modal dialog. The
// dialog holds the MCP address with Copy and no setup commands, and a Copy prompt button that copies
// the getting-started prompt (agent.ts agentPrompt). The address row is today's, built by
// the page's own panel (web/src/agent.ts buildAgentPanel), so the address and its Copy behave exactly as now:
// mcpAddress(page origin), Copied, or "Copy failed — select the address". Copy prompt has its own note.
// Focus moves to Copy on opening; the page behind is inert; Escape, Close or a click on the dimmed page closes it and
// focus returns to the button. It appears as a cut. On a phone it is a bottom sheet (d1.css).
import { AGENT_ADDRESS_LABEL, AGENT_HEADING, buildAgentPanel, buildPromptCopy, mcpAddress, type Clipboard } from "../../agent.ts";
import { h } from "../dom.ts";
import { D1_ICON } from "./icons.ts";
// The word is deck/model.ts PAGE_WORDS.close; read here directly, since that module brings the board renderer with it (squads.ts),
// which the Leaderboard, Matches and Rules pages that share this dialog must not load.
const CLOSE = "Close";

export interface AgentDialog {
  /** The one Bring your agent button; the layout places it in the top bar, or at the deck's end on a phone. */
  readonly button: HTMLButtonElement;
  readonly dialog: HTMLDialogElement;
  destroy(): void;
}

export function mountAgentDialog(doc: Document, host: HTMLElement): AgentDialog {
  const win = doc.defaultView!;
  const button = h(doc, "button", "d1-agent-button", AGENT_HEADING);
  button.type = "button";
  button.setAttribute("aria-haspopup", "dialog");
  const dialog = h(doc, "dialog", "d1-dialog");
  dialog.setAttribute("aria-labelledby", "d1-dialog-title");
  const body = h(doc, "div", "d1-dialog-body");
  const head = h(doc, "div", "d1-dialog-head");
  const title = h(doc, "h2", "d1-dialog-title", AGENT_HEADING);
  title.id = "d1-dialog-title";
  const close = h(doc, "button", "d1-close");
  close.type = "button";
  close.setAttribute("aria-label", CLOSE);
  close.innerHTML = D1_ICON.close;
  head.append(title, close);
  const label = h(doc, "p", "d1-dialog-label", AGENT_ADDRESS_LABEL);
  label.id = "d1-dialog-address";
  // Today's address row only: the address, Copy, and its note, which a screen reader hears politely.
  const clipboard = win.navigator?.clipboard as Clipboard | undefined;
  const address = mcpAddress(win.location.origin);
  const row = buildAgentPanel(doc, address, clipboard).querySelector<HTMLElement>(".aw-byoa-address")!;
  row.querySelector(".aw-byoa-url")?.setAttribute("aria-labelledby", label.id);
  row.querySelector(".aw-byoa-note")?.setAttribute("role", "status");
  const copy = row.querySelector<HTMLButtonElement>(".aw-byoa-copy")!;
  // Copy prompt under the address, its note heard politely too.
  const prompt = buildPromptCopy(doc, address, clipboard);
  prompt.querySelector(".aw-byoa-note")?.setAttribute("role", "status");
  body.append(head, label, row, prompt);
  dialog.append(body);
  host.append(dialog);

  const open = () => {
    if (dialog.open) return;
    dialog.showModal();
    copy.focus();
  };
  const onClose = () => button.focus();
  // A click on the dimmed page lands on the dialog itself, outside its body.
  const onClick = (e: Event) => { if (e.target === dialog) dialog.close(); };
  const shut = () => dialog.close();
  button.addEventListener("click", open);
  close.addEventListener("click", shut);
  dialog.addEventListener("click", onClick);
  dialog.addEventListener("close", onClose);
  return {
    button,
    dialog,
    destroy() {
      button.removeEventListener("click", open);
      close.removeEventListener("click", shut);
      dialog.removeEventListener("click", onClick);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      dialog.remove();
      button.remove();
    },
  };
}
