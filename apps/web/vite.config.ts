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

/** Node-only or heavy packages the browser must never load (core-ts `./browser` is pure). */
export const FORBIDDEN_PACKAGES = ["near-api-js", "libsodium", "bitcoinjs-lib"] as const;

/** The forbidden package a module id belongs to, if any (`libsodium` covers its variants). */
export function forbiddenPackage(id: string): string | null {
  const path = normalizePath(id);
  for (const name of FORBIDDEN_PACKAGES) {
    const pattern =
      name === "libsodium"
        ? /\/node_modules\/libsodium[^/]*\//
        : new RegExp(`/node_modules/${name}/`);
    if (pattern.test(path)) return name;
  }
  return null;
}

/**
 * Fails `vite build` when near-api-js, libsodium or bitcoinjs-lib reaches the bundle: the web
 * imports only `@morrow/core-ts/browser`, whose modules are pure.
 */
function noNodePackagesInBuild(): Plugin {
  return {
    name: "morrow:no-node-packages-in-build",
    apply: "build",
    generateBundle(_options, bundle) {
      const leaked = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of output.moduleIds) {
          const name = forbiddenPackage(id);
          if (name !== null) leaked.add(name);
        }
      }
      if (leaked.size > 0) {
        this.error(
          `${[...leaked].join(", ")} must not be in the production bundle. Import @morrow/core-ts/browser, never @morrow/core-ts, from apps/web.`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), noFixturesInBuild(), noNodePackagesInBuild()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // Every asset ships as its own file: the strict CSP allows no data: URLs.
    assetsInlineLimit: 0,
  },
  test: {
    include: ["src/**/*.test.ts", "server/**/*.test.ts"],
    // The contrast tests read theme.css and landing.css as text (`?raw`); vitest blanks CSS it does not process.
    css: { include: [/theme\.css/, /landing\.css/] },
  },
});
