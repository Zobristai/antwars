import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

/** Serialized into a classic script before any module or preload can resolve.
 * WebKit can retain a failed module URL across navigation. Give the entire graph
 * fresh identities on retry/manual return, not just its entry. No URL data is copied.
 */
export function install3dRecoveryMap(chunks: readonly string[]): void {
  const params = new URL(location.href).searchParams;
  if (!params.has("aw-3d-retry") && !params.has("aw-3d-manual")) return;
  const nonce = [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16)).join("-");
  const imports: Record<string, string> = Object.create(null);
  for (const chunk of chunks) {
    const original = new URL(chunk, document.baseURI);
    const fresh = new URL(original);
    fresh.searchParams.set("aw-3d-load", nonce);
    imports[original.href] = fresh.href;
  }
  const map = document.createElement("script");
  map.type = "importmap";
  map.id = "aw-3d-importmap";
  map.textContent = JSON.stringify({ imports });
  document.currentScript!.after(map);
}

export default defineConfig({
  root,
  base: "./",
  plugins: [{
    name: "3d-recovery-importmap",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle }) {
        if (!bundle) return;
        // The root entry must stay canonical: 3D chunks import its shared exports,
        // and mapping it too would execute the page bootstrap a second time.
        const chunks = Object.values(bundle).filter(chunk => chunk.type === "chunk" && !chunk.isEntry).map(chunk => `./${chunk.fileName}`);
        return [{ tag: "script", attrs: { "data-aw-3d-bootstrap": "" },
          children: `(${install3dRecoveryMap.toString()})(${JSON.stringify(chunks)});`, injectTo: "head-prepend" }];
      },
    },
  }],
  build: {
    // The Rules page's own entry (web/src/pages/rules-entry.ts): the server reads its script and CSS from the
    // manifest (web/rules.ts rulesAssets); the spectator bootstrap never runs there.
    manifest: true,
    rolldownOptions: { input: { index: fileURLToPath(new URL("./index.html", import.meta.url)), rules: fileURLToPath(new URL("./src/pages/rules-entry.ts", import.meta.url)) } },
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
  },
});
