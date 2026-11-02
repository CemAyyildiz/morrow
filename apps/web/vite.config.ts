import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { normalizePath, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

const FIXTURES = normalizePath(fileURLToPath(new URL("./src/fixtures/", import.meta.url)));

/**
 * Fails `vite build` when any `src/fixtures` module is in the output: the mockup's sample
 * data belongs to the dev server only and must never reach a deploy.
 */
function noFixturesInBuild(): Plugin {
  return {
    name: "morrow:no-fixtures-in-build",
    apply: "build",
    generateBundle(_options, bundle) {
      const leaked = Object.values(bundle)
        .flatMap((output) => (output.type === "chunk" ? output.moduleIds : []))
        .map((id) => normalizePath(id))
        .filter((id) => id.startsWith(FIXTURES));
      if (leaked.length > 0) {
        this.error(
          `src/fixtures must not be in the production bundle; found ${leaked
            .map((id) => id.slice(FIXTURES.length))
            .join(", ")}. Load sample data only under import.meta.env.DEV.`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), noFixturesInBuild()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // Every asset ships as its own file: the strict CSP allows no data: URLs.
    assetsInlineLimit: 0,
  },
  test: {
    include: ["src/**/*.test.ts", "server/**/*.test.ts"],
    // contrast.test.ts reads theme.css as text (`?raw`); vitest blanks CSS it does not process.
    css: { include: [/theme\.css/] },
  },
});
