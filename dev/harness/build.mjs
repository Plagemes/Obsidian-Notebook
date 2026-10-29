// Builds the browser harness into dev/harness/dist: the real NotebookView bundled with the
// `obsidian` module replaced by dev/harness/obsidian-stub.ts, plus the plugin's real styles.css.
// Usage: node dev/harness/build.mjs [--serve] [--port=8377]
import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = join(here, "dist");

export async function buildHarness() {
	mkdirSync(out, { recursive: true });
	await esbuild.build({
		entryPoints: [join(here, "harness.ts")],
		bundle: true,
		format: "iife",
		target: "es2021",
		sourcemap: "inline",
		outfile: join(out, "harness.js"),
		alias: { obsidian: join(here, "obsidian-stub.ts") },
		logLevel: "warning",
	});
	copyFileSync(join(here, "index.html"), join(out, "index.html"));
	copyFileSync(join(here, "obsidian-base.css"), join(out, "obsidian-base.css"));
	copyFileSync(join(root, "styles.css"), join(out, "styles.css"));
	return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const dir = await buildHarness();
	console.log(`harness: built ${dir}`);
	if (process.argv.includes("--serve")) {
		const { serve } = await import("./serve.mjs");
		const port = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 8377);
		serve(dir, port);
	}
}
