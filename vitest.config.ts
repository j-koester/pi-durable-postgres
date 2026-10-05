import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// One PostgreSQL database; cases must not run concurrently against it.
		fileParallelism: false,
		testTimeout: 20_000,
		hookTimeout: 30_000,
		pool: "forks",
	},
});
