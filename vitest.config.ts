import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Fixtures have isolated schemas; keep database connection demand bounded.
		fileParallelism: false,
		testTimeout: 20_000,
		hookTimeout: 30_000,
		pool: "forks",
	},
});
