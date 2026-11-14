// The test port's element tree written out as markup, so headless Chromium can lay it out with the client's own
// stylesheets (colony-name-hover.test.ts, colony-name-contrast.test.ts).
import type { ElementPort } from "../pages/dom.ts";

const escape = (text: string) => text.replace(/[&<>"]/g, c => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);
const kebab = (name: string) => name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
/** The port's tree as markup: tags, classes, attributes, data, inline styles, text and the icons' own markup. */
export function markup(node: ElementPort): string {
  if (node.tag === "#text") return escape(node.textContent);
  const attrs: [string, string][] = [];
  if (node.className) attrs.push(["class", node.className]);
  if (node.id) attrs.push(["id", node.id]);
  if (node.title && node.getAttribute("title") === null) attrs.push(["title", node.title]);
  if (node.hidden) attrs.push(["hidden", ""]);
  if (node.open) attrs.push(["open", ""]);
  attrs.push(...Object.entries(node.attrs));
  attrs.push(...Object.entries(node.dataset).map(([key, value]) => [`data-${kebab(key)}`, value] as [string, string]));
  const style = node.style as unknown as Record<string, unknown> & { properties: Map<string, [string, string]> };
  const inline = [...Object.entries(style).filter(([key, value]) => key !== "properties" && typeof value === "string" && value !== "").map(([key, value]) => `${kebab(key)}: ${value as string}`),
    ...[...style.properties].map(([key, [value]]) => `${key}: ${value}`)];
  if (inline.length > 0) attrs.push(["style", inline.join("; ")]);
  const inner = node.children.length > 0 ? node.children.map(markup).join("") : node.html || escape(node.textContent);
  return `<${node.tag}${attrs.map(([key, value]) => ` ${key}="${escape(value)}"`).join("")}>${inner}</${node.tag}>`;
}
