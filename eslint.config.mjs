import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// CLAUDE.md rule 1: runtime code also runs in the Android WebView.
const NODE_ONLY = [
	"fs", "fs/promises", "path", "os", "child_process", "crypto", "electron",
	"stream", "util", "url", "buffer", "process", "worker_threads",
].flatMap((name) => [name, `node:${name}`]);

export default tseslint.config(
	{ ignores: ["main.js", "node_modules/**", "coverage/**"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
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
		files: ["src/ink/**/*.ts", "src/model/**/*.ts", "src/storage/session.ts"],
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
		files: ["tests/**/*.ts", "*.mjs", "*.ts", "scripts/**/*.mjs"],
		languageOptions: { globals: globals.node },
	},
);
