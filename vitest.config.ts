import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		projects: [
			// Generous timeouts: heavy geometry/fuzz tests take a few seconds alone and several times that when the whole suite
			// (or other processes) load the CPU. A timeout here means a hang, not slowness.
			// `css`: styles.css is read with `?raw` by tests/styles.test.ts (CSS is stubbed out otherwise).
			{ test: { name: "unit", include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 60_000, hookTimeout: 60_000, css: { include: [/styles\.css/] } } },
			// Benchmarks: `npm run bench`. Not part of `npm test`.
			{ test: { name: "perf", include: ["tests/**/*.perf.ts"], environment: "node", testTimeout: 120_000 } },
		],
	},
});
