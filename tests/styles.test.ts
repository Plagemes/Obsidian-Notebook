import { describe, expect, it } from "vitest";
import css from "../styles.css?raw";

/**
 * Guards against a broken styles.css. 0.4.0 shipped a file whose "view wave 2" and "integration P1"
 * sections had lost their closing braces and many declarations in two merges: browsers with CSS
 * nesting read everything after it as nested rules that never match, so `.notebook-body` was no
 * longer a flex container, the stage had zero height and the page area stayed empty (black in the
 * dark theme) with no input reaching it.
 */

/** Top-level rules: selector → declarations (comments removed; @media blocks flattened). */
function parseRules(source: string): { rules: Map<string, Map<string, string>>; maxRuleDepth: number; balance: number } {
	const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = new Map<string, Map<string, string>>();
	const stack: Array<{ selector: string; atRule: boolean }> = [];
	let buf = "";
	let maxRuleDepth = 0;
	let balance = 0;
	for (const ch of text) {
		if (ch === "{") {
			const selector = buf.trim().replace(/\s+/g, " ");
			stack.push({ selector, atRule: selector.startsWith("@") });
			balance++;
			maxRuleDepth = Math.max(maxRuleDepth, stack.filter((s) => !s.atRule).length);
			buf = "";
		} else if (ch === "}") {
			const top = stack.pop();
			balance--;
			if (top && !top.atRule) {
				const decls = rules.get(top.selector) ?? new Map<string, string>();
				for (const d of buf.split(";")) {
					const i = d.indexOf(":");
					if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
				}
				rules.set(top.selector, decls);
			}
			buf = "";
		} else {
			buf += ch;
		}
	}
	return { rules, maxRuleDepth, balance };
}

describe("styles.css", () => {
	const { rules, maxRuleDepth, balance } = parseRules(css);

	it("has balanced braces and no nested style rules", () => {
		expect(balance).toBe(0);
		// Style rules only at top level or inside an at-rule (@media): no accidental nesting.
		expect(maxRuleDepth).toBe(1);
	});

	it("keeps the declarations the page layout depends on", () => {
		const expectDecl = (selector: string, prop: string, value: string) => {
			expect(rules.get(selector)?.get(prop), `${selector} { ${prop}: ${value} }`).toBe(value);
		};
		expectDecl(".workspace-leaf-content .view-content.notebook-view", "display", "flex");
		expectDecl(".notebook-body", "display", "flex");
		expectDecl(".notebook-body", "flex", "1 1 auto");
		expectDecl(".notebook-body", "min-height", "0");
		expectDecl(".notebook-body > .notebook-stage", "flex", "1 1 0");
		expectDecl(".notebook-stage", "position", "relative");
		expectDecl(".notebook-canvas", "position", "absolute");
		expectDecl(".notebook-canvas", "inset", "0");
		expectDecl(".notebook-canvas-live", "pointer-events", "none");
		expectDecl(".notebook-canvas-wet", "pointer-events", "none");
		expectDecl(".notebook-navigator.notebook-hidden", "display", "none");
		expectDecl(".notebook-body.is-narrow > .notebook-navigator", "position", "absolute");
	});

	it("keeps the toolbar compact: touch targets of 40 px, popovers under the bar, a scrolling favourites strip", () => {
		const expectDecl = (selector: string, prop: string, value: string) => {
			expect(rules.get(selector)?.get(prop), `${selector} { ${prop}: ${value} }`).toBe(value);
		};
		expectDecl(".notebook-tool", "min-width", "40px");
		expectDecl(".notebook-tool", "min-height", "40px");
		expectDecl(".notebook-toolbar", "flex-wrap", "wrap");
		expectDecl(".notebook-popover", "position", "absolute");
		expectDecl(".notebook-popover.notebook-hidden", "display", "none");
		expectDecl(".notebook-favs", "overflow-x", "auto");
	});

	it("scopes every design-system rule under .nb-ui, above Obsidian's own button and input rules (0.12.1)", () => {
		// Obsidian's app.css styles `button:not(.clickable-icon)`, `button:hover` and `input[type=…]` at specificity 0,1,1:
		// a single-class component rule loses to them (0.12.0 showed Obsidian's grey pills on the device). Every rule of
		// the 0.12 section carries the .nb-ui scope (0,2,0 or more); the settings tab and the leaf rule are outside it.
		const start = css.indexOf("/* ===== 0.12: Home and the library on the design system");
		expect(start).toBeGreaterThan(0);
		const section = parseRules(css.slice(start)).rules;
		const splitTop = (list: string) => {
			const out: string[] = [];
			let depth = 0;
			let cur = "";
			for (const ch of list) {
				if (ch === "(") depth++;
				if (ch === ")") depth--;
				if (ch === "," && depth === 0) {
					out.push(cur.trim());
					cur = "";
				} else cur += ch;
			}
			return [...out, cur.trim()];
		};
		const unscoped = [...section.keys()].flatMap(splitTop)
			.filter((sel) => !sel.startsWith(".workspace-leaf-content") && !sel.startsWith(".notebook-settings"))
			.filter((sel) => !sel.includes(".nb-ui"));
		expect(unscoped).toEqual([]);
		// The reset that neutralises Obsidian's defaults inside the scope.
		expect(section.get(".nb-ui button")?.get("background-color")).toBe("transparent");
		expect(section.get(".nb-ui button")?.get("box-shadow")).toBe("none");
		expect(section.get(".nb-ui button")?.get("height")).toBe("auto");
	});

	it("never makes the pen's wet canvas translucent or blended", () => {
		const wet = rules.get(".notebook-canvas-wet");
		expect(wet?.get("opacity")).toBeUndefined();
		expect(wet?.get("mix-blend-mode")).toBeUndefined();
		expect(wet?.get("background") ?? wet?.get("background-color")).toBeUndefined();
	});
});
