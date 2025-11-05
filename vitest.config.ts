import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Force sequential test execution to avoid lock file conflicts
    // Tests use file-based locking which cannot safely run in parallel
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
        maxForks: 1,
        minForks: 1,
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      lines: 0.8,
      statements: 0.8,
    },
  },
});
