import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "target/**",
      "_bmad/**",
      "_bmad-output/**",
      ".claude/**",
      "docs/**",
      // Pinned third-party wallet executors, byte for byte as fetched (apps/web/src/vault/wallets.ts).
      "apps/web/public/wallets/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Tests may assert presence with `!` after checking lengths.
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    files: [".github/scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
  },
);
