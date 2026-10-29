import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		projects: [
			{ test: { name: "unit", include: ["tests/**/*.test.ts"], environment: "node" } },
			// Benchmarks: `npm run bench`. Not part of `npm test`.
			{ test: { name: "perf", include: ["tests/**/*.perf.ts"], environment: "node", testTimeout: 120_000 } },
		],
	},
});
