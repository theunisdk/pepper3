import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only our tests. The default glob scans the whole tree and trips over
    // runtime state under var/ (Codex drops plugin fixtures with *.test.*
    // names into its CODEX_HOME scratch dir).
    include: ['tests/**/*.test.ts'],
  },
});
