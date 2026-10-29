import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		projects: [
			// `css`: styles.css is read with `?raw` by tests/styles.test.ts (CSS is stubbed out otherwise).
			{ test: { name: "unit", include: ["tests/**/*.test.ts"], environment: "node", css: { include: [/styles\.css/] } } },
			// Benchmarks: `npm run bench`. Not part of `npm test`.
			{ test: { name: "perf", include: ["tests/**/*.perf.ts"], environment: "node", testTimeout: 120_000 } },
		],
	},
});
