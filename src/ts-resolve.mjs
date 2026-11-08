// Lets `npm start` run the TypeScript sources directly on Node 24 (type stripping),
// with no build step: a relative import of a missing .js file resolves to its .ts file.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".") || !specifier.endsWith(".js")) throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
