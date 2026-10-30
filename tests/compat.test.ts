import { describe, expect, it } from "vitest";
import esbuildConfig from "../esbuild.config.mjs?raw";

// 0.12.3: the plugin runs in Android System WebViews that may be a few Chrome versions old, and in Obsidian's own DOM
// helpers. These guards catch, in Node, what only failed on the device.
const SOURCES = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

/** Source text without comments (so a comment may name what the code must not use). */
function code(src: string): string {
	// Block comments keep their line breaks, so the line numbers of a hit stay right.
	return src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, "")).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Built-ins newer than Chrome ~105–110 (Android System WebView on older tablets), with the version that added them. */
const TOO_NEW: Array<[RegExp, string]> = [
	[/\bObject\.groupBy\b/, "Object.groupBy (Chrome 117)"],
	[/\bMap\.groupBy\b/, "Map.groupBy (Chrome 117)"],
	[/\.toSorted\(/, "Array.prototype.toSorted (Chrome 110)"],
	[/\.toReversed\(/, "Array.prototype.toReversed (Chrome 110)"],
	[/\.toSpliced\(/, "Array.prototype.toSpliced (Chrome 110)"],
	[/\]\.with\(|\bArray\.prototype\.with\b/, "Array.prototype.with (Chrome 110)"],
	[/\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, "Set methods (Chrome 122)"],
	[/\bArray\.fromAsync\b/, "Array.fromAsync (Chrome 121)"],
	[/\bPromise\.withResolvers\b/, "Promise.withResolvers (Chrome 119)"],
	[/\.(isWellFormed|toWellFormed)\(/, "String well-formed methods (Chrome 111)"],
	[/\bstructuredClone\(/, "structuredClone (Chrome 98, and not in every WebView build)"],
	[/\.roundRect\(/, "CanvasRenderingContext2D.roundRect (Chrome 99)"],
	[/\.letterSpacing\b/, "CanvasRenderingContext2D.letterSpacing (Chrome 99)"],
	[/\.checkVisibility\(/, "Element.checkVisibility (Chrome 105)"],
	// (Our own toolbar has a `togglePopover` method of its own: only the DOM's show/hide and the attribute count.)
	[/\.showPopover\(|\.hidePopover\(|\b(?:setAttribute|setAttr)\(\s*["']popover["']|\battr:\s*\{[^}]*\bpopover:/, "the popover API (Chrome 114)"],
	[/\/[^/\n]+\/[dgimsuy]*v[dgimsuy]*\.(test|exec)\(/, "regular expression v flag (Chrome 112)"],
];

describe("compatibility with older Android WebViews (0.12.3)", () => {
	it("src uses no built-in newer than the WebViews we support", () => {
		const hits: string[] = [];
		for (const [file, raw] of Object.entries(SOURCES)) {
			const lines = code(raw).split("\n");
			lines.forEach((line, i) => {
				for (const [re, what] of TOO_NEW) if (re.test(line)) hits.push(`${file}:${i + 1}: ${what}`);
			});
		}
		expect(hits).toEqual([]);
	});

	it("esbuild down-levels syntax for Chrome 100 (ES2020)", () => {
		expect(esbuildConfig).toMatch(/target:\s*\["es2020",\s*"chrome100"\]/);
	});
});

describe("Obsidian DOM helpers (0.12.3)", () => {
	// `createEl` on a node appends the new element to that node. On a Document it would append a second root element and
	// throw "HierarchyRequestError: Only one element on document allowed": in 0.12.2 every generated picture failed this way
	// and took the rest of Home, the library header and the creation dialog with it. Detached elements: the global createEl.
	const KNOWN: string[] = [];

	it("never calls createEl / createDiv / createSpan / createSvg on a Document", () => {
		const hits: string[] = [];
		for (const [file, raw] of Object.entries(SOURCES)) {
			if (KNOWN.includes(file)) continue;
			code(raw).split("\n").forEach((line, i) => {
				if (/\b(?:activeDocument|document|ownerDocument|\.doc)\.create(?:El|Div|Span|Svg)\(/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
			});
		}
		expect(hits).toEqual([]);
	});
});
