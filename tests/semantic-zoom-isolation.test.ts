import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";

const SOURCES = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

/** The semantic zoom (roadmap #130) is a view overlay: only the notebook view mounts it, and nothing that writes a file or draws an output may reach it. */
describe("semantic zoom stays a view overlay", () => {
	const importers = Object.entries(SOURCES)
		.filter(([path, text]) => /from "[^"]*semantic-(zoom|sources)"/.test(text) && !/semantic-(zoom|sources)\.ts$/.test(path))
		.map(([path]) => path.replace("../src/", ""));

	it("is imported by the notebook view and by nothing that exports, presents or hands in", () => {
		expect(importers.sort()).toEqual(["view/notebook-view.ts"]);
	});

	it("the pure modules do not import the DOM layer, 'obsidian' or the renderer", () => {
		for (const name of ["ink/semantic-zoom.ts", "model/semantic-sources.ts"]) {
			const text = SOURCES[`../src/${name}`]!;
			expect(text, name).not.toMatch(/from "obsidian"/);
			expect(text, name).not.toMatch(/from "[^"]*(renderer|\/view\/)/);
		}
	});

	it("the layer reads the document and never builds a command or writes", () => {
		const text = SOURCES["../src/view/semantic-zoom.ts"]!;
		expect(text).not.toMatch(/history|execute\(|saveSettings|vault|app\./i);
	});

	it("does not touch the stroke level of detail", () => {
		for (const name of ["ink/semantic-zoom.ts", "view/semantic-zoom.ts", "model/semantic-sources.ts"]) {
			expect(SOURCES[`../src/${name}`]!, name).not.toMatch(/from "[^"]*\/lod"/);
		}
	});
});

describe("semantic zoom setting", () => {
	it("is on by default and read leniently", () => {
		expect(DEFAULT_SETTINGS.semanticZoom).toBe(true);
		expect(readSettings({ semanticZoom: false }).semanticZoom).toBe(false);
		expect(readSettings({ semanticZoom: "no" }).semanticZoom).toBe(true);
		expect(readSettings(undefined).semanticZoom).toBe(true);
	});
});
