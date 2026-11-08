// A small DOM port for the Archive pages' unit tests: enough tree, attributes, events and dialog to mount the
// pages and read what they show. Not rendering or visual evidence; the served build's captures are that.
export class ElementPort {
  id = ""; className = ""; type = ""; hidden = false; disabled = false; focused = false; tabIndex = 0; open = false;
  scope = ""; colSpan = 1; rowSpan = 1; src = ""; alt = ""; decoding = ""; title = ""; target = ""; rel = "";
  dataset: Record<string, string> = {}; attrs: Record<string, string> = {};
  children: ElementPort[] = []; parent: ElementPort | null = null;
  listeners = new Map<string, Set<(event: any) => void>>();
  private text = "";
  style = {
    properties: new Map<string, [string, string]>(),
    setProperty(key: string, value: string, priority = "") { this.properties.set(key, [value, priority]); },
    getPropertyValue(key: string) { return this.properties.get(key)?.[0] ?? ""; },
    getPropertyPriority(key: string) { return this.properties.get(key)?.[1] ?? ""; },
    removeProperty(key: string) { this.properties.delete(key); },
  } as { [key: string]: unknown; properties: Map<string, [string, string]>; setProperty(k: string, v: string, p?: string): void; getPropertyValue(k: string): string; getPropertyPriority(k: string): string; removeProperty(k: string): void };
  classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.classes(), ...names])].join(" "); },
    remove: (...names: string[]) => { this.className = this.classes().filter(name => !names.includes(name)).join(" "); },
    contains: (name: string) => this.classes().includes(name),
    toggle: (name: string, force = !this.classes().includes(name)) => {
      if (force) this.classList.add(name); else this.classList.remove(name);
      return force;
    },
  };
  constructor(public tag = "div") {}
  classes() { return this.className.split(/\s+/).filter(Boolean); }
  /** Own text plus every descendant's, as a browser's textContent reads. */
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { for (const node of [...this.children]) node.remove(); this.text = value ?? ""; }
  /** Markup written into the element: the pages write only their own icons this way, never provider text. */
  html = "";
  set innerHTML(value: string) { this.html = value; }
  get href() { return this.getAttribute("href") ?? ""; }
  set href(value: string) { this.setAttribute("href", value); }
  get isConnected(): boolean { let node: ElementPort | null = this; while (node.parent) node = node.parent; return node.tag === "html"; }
  get parentElement() { return this.parent; }
  get firstElementChild(): ElementPort | null { return this.children.find(node => !node.tag.startsWith("#")) ?? null; }
  get childElementCount() { return this.children.filter(node => !node.tag.startsWith("#")).length; }
  append(...nodes: (ElementPort | string)[]) {
    for (const value of nodes) {
      const node = typeof value === "string" ? Object.assign(new ElementPort("#text"), { textContent: value }) : value;
      node.remove(); node.parent = this; this.children.push(node);
    }
  }
  prepend(node: ElementPort) { node.remove(); node.parent = this; this.children.unshift(node); }
  after(...nodes: ElementPort[]) {
    const p = this.parent!;
    let at = p.children.indexOf(this) + 1;
    for (const node of nodes) { node.remove(); node.parent = p; p.children.splice(at++, 0, node); }
  }
  before(node: ElementPort) { const p = this.parent!; node.remove(); node.parent = p; p.children.splice(p.children.indexOf(this), 0, node); }
  /** The test document this element was created by: focus() and removal keep its activeElement as a browser does. */
  owner: { activeElement: ElementPort | null; body: ElementPort } | null = null;
  remove() {
    if (!this.parent) return;
    const wasConnected = this.isConnected;
    this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null;
    // A browser moves focus to the body when the focused element, or an ancestor of it, leaves the document.
    const active = this.owner?.activeElement ?? null;
    if (wasConnected && active && this.contains(active)) { active.focused = false; this.owner!.activeElement = this.owner!.body; }
  }
  replaceChildren(...nodes: ElementPort[]) { for (const node of [...this.children]) node.remove(); this.text = ""; this.append(...nodes); }
  contains(node: ElementPort | null): boolean { return node !== null && (this === node || this.children.some(child => child.contains(node))); }
  setAttribute(name: string, value: string) { this.attrs[name] = String(value); }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  hasAttribute(name: string) { return Object.hasOwn(this.attrs, name); }
  removeAttribute(name: string) { delete this.attrs[name]; }
  /** Tag, .class, [attr] and [attr="value"] selectors only; descendants, in tree order. */
  querySelectorAll(selector: string): ElementPort[] {
    const attr = /^\[([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\]$/.exec(selector);
    if (!attr && !/^(?:[a-z][\w-]*|\.[\w-]+)$/.test(selector)) throw new Error(`Unsupported test selector: ${selector}`);
    // [data-x] reads dataset.x, as a browser maps the two; a quoted value's backslash escapes are undone.
    const value = attr?.[2]?.replace(/\\(.)/g, "$1");
    const read = (node: ElementPort, name: string) => name.startsWith("data-")
      ? node.dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] ?? node.getAttribute(name)
      : node.getAttribute(name);
    return this.all().slice(1).filter(node => {
      if (attr) { const found = read(node, attr[1]!); return found !== null && (value === undefined || found === value); }
      if (selector.startsWith(".")) return node.classes().includes(selector.slice(1));
      return node.tag === selector;
    });
  }
  querySelector(selector: string): ElementPort | null { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  scrollIntoView() {}
  addEventListener(name: string, callback: (event: any) => void) { const set = this.listeners.get(name) ?? new Set(); set.add(callback); this.listeners.set(name, set); }
  removeEventListener(name: string, callback: (event: any) => void) { this.listeners.get(name)?.delete(callback); }
  fire(name: string, event: any = {}) { for (const listener of [...this.listeners.get(name) ?? []]) listener({ target: this, ...event }); }
  click() { if (!this.disabled) this.fire("click"); }
  focus() {
    this.focused = true;
    // A connected element becomes the document's one active element, as in a browser.
    if (this.owner && this.isConnected) {
      if (this.owner.activeElement && this.owner.activeElement !== this) this.owner.activeElement.focused = false;
      this.owner.activeElement = this;
    }
  }
  showModal() { this.open = true; }
  close() { if (this.open) { this.open = false; this.fire("close"); } }
  all(): ElementPort[] { return [this, ...this.children.flatMap(child => child.all())]; }
  /** Every descendant (or self) with this class. */
  byClass(name: string): ElementPort[] { return this.all().filter(node => node.classes().includes(name)); }
}

// The pages test `instanceof HTMLElement`; in this port every element is one.
(globalThis as { HTMLElement?: unknown }).HTMLElement ??= ElementPort;
// The pages find a control again with CSS.escape; Node has none. Enough for a quoted attribute value.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value.replace(/["\\]/g, "\\$&") };

export function dom(options: { search?: string; wide?: boolean; meta?: Record<string, string> } = {}) {
  const html = new ElementPort("html"), head = new ElementPort("head"), body = new ElementPort("body"), events = new ElementPort();
  html.append(head, body);
  const query = { matches: options.wide ?? true, addEventListener() {}, removeEventListener() {} };
  const win = {
    location: { search: options.search ?? "", hash: "", origin: "https://antwars.example" },
    navigator: {},
    innerWidth: 1440, innerHeight: 900,
    matchMedia: () => query,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    dispatchEvent() {},
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  };
  const doc = {
    body, head, documentElement: html, defaultView: win, title: "Antwars", activeElement: null as ElementPort | null,
    createElement: (tag: string): ElementPort => { const node = new ElementPort(tag); node.owner = doc; return node; },
    createComment: () => new ElementPort("#comment"),
    getElementById: (id: string) => html.all().find(node => node.id === id) ?? null,
    querySelector: (selector: string) => {
      const meta = /^meta\[name="([^"]+)"\]$/.exec(selector);
      if (meta) { const content = options.meta?.[meta[1]!]; return content === undefined ? null : { getAttribute: () => content }; }
      if (selector === "body > main") return body.children.find(node => node.tag === "main") ?? null;
      return html.querySelector(selector);
    },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  };
  for (const node of [html, head, body]) node.owner = doc;
  return { html, body, events, win: win as unknown as Window & typeof globalThis, doc: doc as unknown as Document };
}
