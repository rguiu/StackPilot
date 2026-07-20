import { defineConfig } from "vitest/config";

// Only discover tests under src/. Without this, a prior `npm run build` leaves
// compiled *.test.js copies in dist/ that vitest would also run — doubling the
// reported count and testing stale output instead of source.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
