import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";

// CLAUDE.md rule 1: runtime code also runs in the Android WebView.
const NODE_ONLY = [
	"fs", "fs/promises", "path", "os", "child_process", "crypto", "electron",
	"stream", "util", "url", "buffer", "process", "worker_threads",
].flatMap((name) => [name, `node:${name}`]);

// Obsidian's community Scorecard lints the repository with eslint-plugin-obsidianmd's `recommended` config (type-checked
// typescript-eslint rules, eslint-comments rules, obsidianmd rules). `npm run lint` runs the same config on these files.
// Its blocks are re-scoped here: each TypeScript block (and the ones without `files`: core rules, browser globals,
// unused-directive reporting) applies only to OBSIDIAN_TS; the JavaScript-only blocks are left out (no runtime .js);
// the package.json block is kept as it is.
const OBSIDIAN_TS = [
	"src/**/*.ts",
	"tests/**/*.ts",
	"dev/**/*.ts",
];
const isJsOnly = (files) => files.flat().every((f) => typeof f === "string" && /\{js,cjs,mjs,jsx\}$/.test(f));
const obsidianRecommended = obsidianmd.configs.recommended.flatMap((c) => {
	if (!c.files) return [{ ...c, files: OBSIDIAN_TS }];
	if (c.files.length === 1 && c.files[0] === "package.json") return [c];
	if (isJsOnly(c.files)) return [];
	return [{ ...c, files: OBSIDIAN_TS }];
});

export default tseslint.config(
	{ ignores: ["main.js", "node_modules/**", "coverage/**", "dev/harness/dist/**"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	...obsidianRecommended,
	{
		// Type information for the type-checked rules of the block above.
		files: OBSIDIAN_TS,
		languageOptions: { parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname } },
	},
	{
		files: ["src/**/*.ts"],
		languageOptions: { globals: globals.browser },
		rules: {
			"no-restricted-imports": ["error", {
				paths: NODE_ONLY.map((name) => ({ name, message: "Node/Electron modules are not allowed at runtime (runs on Android)." })),
			}],
			"no-restricted-syntax": ["error",
				{ selector: "CallExpression[callee.name='require']", message: "Dynamic require is not allowed at runtime." },
				{ selector: "ImportExpression", message: "Dynamic import() is not allowed at runtime." },
			],
			"no-restricted-globals": ["error",
				{ name: "require", message: "require is not allowed at runtime." },
				{ name: "process", message: "process does not exist on Android." },
			],
			"@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
		},
	},
	{
		// ink/ and model/ must stay testable in Node without Obsidian.
		files: [
			"src/ink/**/*.ts", "src/model/**/*.ts", "src/storage/session.ts",
			// wave 0.6: zettelkasten pure logic
			"src/zettel/subpath.ts", "src/zettel/ids.ts", "src/zettel/card-content.ts", "src/zettel/arrows.ts", "src/zettel/settings.ts", "src/zettel/local-pages.ts",
			// wave 0.7: sync safety pure logic
			"src/storage/sync-state.ts", "src/storage/presence-logic.ts",
		],
		rules: {
			"no-restricted-imports": ["error", {
				paths: [
					{ name: "obsidian", message: "ink/, model/ and storage/session.ts must not import 'obsidian'." },
					...NODE_ONLY.map((name) => ({ name, message: "Node/Electron modules are not allowed at runtime." })),
				],
			}],
		},
	},
	{
		files: ["tests/**/*.ts", "*.mjs", "*.ts", "scripts/**/*.mjs", "dev/**/*.mjs"],
		languageOptions: { globals: globals.node },
	},
	{
		// Browser harness page (dev only, never bundled into main.js).
		files: ["dev/**/*.ts"],
		languageOptions: { globals: globals.browser },
	},
);
