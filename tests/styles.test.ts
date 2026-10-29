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

	it("never makes the pen's wet canvas translucent or blended", () => {
		const wet = rules.get(".notebook-canvas-wet");
		expect(wet?.get("opacity")).toBeUndefined();
		expect(wet?.get("mix-blend-mode")).toBeUndefined();
		expect(wet?.get("background") ?? wet?.get("background-color")).toBeUndefined();
	});
});
