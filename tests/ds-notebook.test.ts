import { describe, expect, it } from "vitest";
import css from "../styles.css?raw";
import { TOOLBAR_SIZES, dialScale, toolbarScale, toolbarScaleFor, toolsRowWraps } from "../src/ui/toolbar-size";

// 0.13 ds-notebook: the notebook's editing chrome on the design system.
const MARK = "/* ===== 0.13 ds-notebook ===== */";
const VIEW = ".workspace-leaf-content .view-content.notebook-view";

function block(): string {
	const start = css.indexOf(MARK);
	expect(start).toBeGreaterThan(0);
	const end = css.indexOf("/* ===== 0.13", start + MARK.length);
	return css.slice(start, end > 0 ? end : undefined).replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The selectors of the block's rules (at-rule preludes skipped, selector lists split at top-level commas). */
function selectors(source: string): string[] {
	const out: string[] = [];
	for (const m of source.matchAll(/([^{}]+)\{/g)) {
		const prelude = m[1]!.trim();
		if (prelude.startsWith("@")) continue;
		let depth = 0;
		let cur = "";
		for (const ch of prelude) {
			if (ch === "(") depth++;
			if (ch === ")") depth--;
			if (ch === "," && depth === 0) {
				out.push(cur.trim());
				cur = "";
			} else cur += ch;
		}
		out.push(cur.trim());
	}
	return out;
}

describe("toolbar size presets (0.13)", () => {
	it("keeps every touch target at 40 px or more, and 44 px at the normal size", () => {
		for (const size of TOOLBAR_SIZES) expect(toolbarScale(size).target).toBeGreaterThanOrEqual(40);
		expect(toolbarScale("normal").target).toBeGreaterThanOrEqual(44);
	});

	it("budgets a slot that holds the button and its 2 px gap, and grows with the size", () => {
		for (const size of TOOLBAR_SIZES) {
			const s = toolbarScale(size);
			expect(s.slot).toBeGreaterThanOrEqual(s.target + 2);
			expect(s.icon).toBeLessThan(s.target);
		}
		expect(toolbarScale("compact").slot).toBeLessThan(toolbarScale("normal").slot);
		expect(toolbarScale("normal").slot).toBeLessThan(toolbarScale("large").slot);
	});

	it("wraps the tools row only when it does not fit, later the narrower the buttons", () => {
		for (const size of TOOLBAR_SIZES) {
			expect(toolsRowWraps(size, 1280)).toBe(false);
		}
		expect(toolsRowWraps("normal", 412)).toBe(false);
		expect(toolsRowWraps("large", 412)).toBe(true);
	});

	it("falls back to 40 px targets on a view too narrow for eight 44 px ones, and only at the normal size", () => {
		expect(toolbarScaleFor("normal", 800).target).toBe(44);
		expect(toolbarScaleFor("normal", 360).target).toBe(40);
		expect(toolbarScaleFor("normal", 360).slot).toBe(toolbarScale("compact").slot);
		expect(toolbarScaleFor("normal", 360).dial).toBe(1);
		expect(toolbarScaleFor("large", 360)).toEqual(toolbarScale("large"));
		expect(toolbarScaleFor("compact", 360)).toEqual(toolbarScale("compact"));
		expect(toolsRowWraps("normal", 360)).toBe(false);
	});

	it("keeps the dial between 0.6 and its designed size", () => {
		expect(dialScale(10, "large")).toBeCloseTo(1.2);
		expect(dialScale(0.1, "normal")).toBe(0.6);
	});
});

describe("the 0.13 chrome block in styles.css", () => {
	it("is scoped under the view root, the status bar item or the menu (above Obsidian's 0,1,1 button rules)", () => {
		const bad = selectors(block()).filter((s) => !s.startsWith(VIEW) && !s.startsWith(".nb-ui."));
		expect(bad).toEqual([]);
	});

	it("has balanced braces", () => {
		const text = block();
		expect([...text].filter((c) => c === "{").length).toBe([...text].filter((c) => c === "}").length);
	});

	it("uses tokens, not raw colours, for its surfaces (the white of a primary button and the dial's own navy aside)", () => {
		const raw = block().match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
		const allowed = new Set(["#ffffff", "#0f1522", "#1b2539", "#f4f6fb"]);
		expect(raw.filter((c) => !allowed.has(c.toLowerCase()))).toEqual([]);
	});

	it("turns the blur, the glows and the transitions off for reduced motion", () => {
		const text = block();
		const reduced = text.slice(text.indexOf("@media (prefers-reduced-motion: reduce)"));
		expect(reduced).toContain("backdrop-filter: none");
		expect(reduced).toContain("transition: none");
	});

	it("keeps 44 px targets for the chrome's text buttons on touch", () => {
		const text = block();
		const touch = text.slice(text.indexOf("@media (pointer: coarse)"));
		expect(touch).toMatch(/\.notebook-tab[\s\S]*?min-height: 44px/);
		expect(touch).toMatch(/\.notebook-practice-button[\s\S]*?min-height: 44px/);
	});
});
