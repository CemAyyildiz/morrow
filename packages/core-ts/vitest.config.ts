import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one regtest node and mine blocks; run files one at a time.
    fileParallelism: false,
  },
});
