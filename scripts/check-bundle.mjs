// Checks that main.js does not require Node/Electron modules (CLAUDE.md rule 1).
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

const bundle = readFileSync("main.js", "utf8");
const allowed = new Set(["obsidian"]);
const found = new Set();
for (const m of bundle.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
	found.add(m[1]);
}
const forbidden = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`), "electron"]);
const bad = [...found].filter((name) => !allowed.has(name));
const nodeHits = bad.filter((name) => forbidden.has(name) || name.startsWith("node:") || name.startsWith("@electron"));
const dynamic = /\brequire\(\s*[^"'`\s)]/.test(bundle);

if (bad.length > 0 || dynamic) {
	console.error("check-bundle: disallowed imports in main.js:", bad.join(", ") || "(dynamic require)");
	if (nodeHits.length) console.error("  Node/Electron modules:", nodeHits.join(", "));
	process.exit(1);
}
console.log(`check-bundle: ok (requires found: ${[...found].join(", ") || "none"})`);
