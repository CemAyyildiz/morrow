import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // Every asset ships as its own file: the strict CSP of story 1.9b allows no data: URLs.
    assetsInlineLimit: 0,
  },
  test: {
    include: ["src/**/*.test.ts"],
    // contrast.test.ts reads theme.css as text (`?raw`); vitest blanks CSS it does not process.
    css: { include: [/theme\.css/] },
  },
});
