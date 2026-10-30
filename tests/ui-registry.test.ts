import { describe, expect, it } from "vitest";
import { ACTIONS, activeContexts, baseContext, isEnabled, isRelevant, type UiContext } from "../src/ui/actions";
import { placementsOf } from "../src/ui/layout";

import i18n from "../src/i18n.ts?raw";

/** The text of every source file, by path ("../src/…"). */
const SOURCES = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

/** Command ids written literally in `addCommand({ id: "…" })` or zettel's `viewCommand("…")` anywhere in src/. */
function literalCommandIds(): Map<string, string> {
	const out = new Map<string, string>();
	for (const [file, text] of Object.entries(SOURCES)) {
		for (const m of text.matchAll(/addCommand\(\{\s*id:\s*"([^"]+)"/g)) out.set(m[1]!, file);
		for (const m of text.matchAll(/addCommand\(\{\s*\n\s*id:\s*"([^"]+)"/g)) out.set(m[1]!, file);
		for (const m of text.matchAll(/viewCommand\("([^"]+)"/g)) out.set(m[1]!, file);
		for (const m of text.matchAll(/command\("(pdf-side-[^"]+)"/g)) out.set(m[1]!, file);
	}
	return out;
}

/** Contexts that together cover every situation an action can be relevant in. */
const CONTEXTS: Array<[string, UiContext]> = [
	["plain page", baseContext()],
	["bookmarked last page", baseContext({ page: { index: 2, count: 3, background: "none", infinite: true, bookmarked: true } })],
	["selection with an image", baseContext({ tool: "lasso", selection: { strokes: 2, elements: 1, images: 1 } })],
	["selection with a link", baseContext({ tool: "lasso", selection: { strokes: 0, elements: 1, images: 0, links: 1 } })],
	["selection with an equation (wave 0.9: math)", baseContext({ tool: "lasso", selection: { strokes: 0, elements: 1, images: 0, equations: 1, graphs: 0 } })],
	["lasso, nothing selected", baseContext({ tool: "lasso" })],
	["PDF page", baseContext({ page: { index: 1, count: 3, background: "pdf", infinite: false, bookmarked: false }, notebook: { pdfPages: true, backgrounds: true } })],
	["image page", baseContext({ page: { index: 1, count: 3, background: "image", infinite: false, bookmarked: false }, notebook: { pdfPages: false, backgrounds: true } })],
	["PDF side pane open", baseContext({ sidePane: { available: true, open: true }, notebook: { pdfPages: true, backgrounds: true } })],
	["class now", baseContext({ lecture: true })],
	["history to go back and forward (wave 0.10)", baseContext({ nav: { back: true, forward: true } })],
	["heavy page", baseContext({ page: { index: 0, count: 3, background: "none", infinite: false, bookmarked: false, splittable: true } })],
];
const WIDTHS = [360, 800, 1280];

describe("action registry", () => {
	it("has unique ids, valid priorities and at least one surface per action", () => {
		const ids = ACTIONS.map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const a of ACTIONS) {
			expect(a.surfaces.length, a.id).toBeGreaterThan(0);
			expect(a.priority, a.id).toBeGreaterThanOrEqual(0);
			expect(a.priority, a.id).toBeLessThanOrEqual(100);
			if (a.surfaces.includes("context")) expect(a.contexts?.length, `${a.id} needs contexts`).toBeGreaterThan(0);
			if (a.scope === "external") expect(a.owner, a.id).toBeTruthy();
			if (a.scope === "external" && !a.command) expect(a.surfaces, `${a.id}: a banner button`).toEqual(["banner"]);
			expect(a.icon, a.id).toMatch(/^[a-z0-9-]+$/);
		}
	});

	it("uses label and command names that exist in the English strings", () => {
		const en = i18n.slice(0, i18n.indexOf("} as const;"));
		for (const a of ACTIONS) {
			expect(en.includes(`"${a.label}":`), `${a.id}: ${a.label}`).toBe(true);
			if (typeof a.command === "string") expect(en.includes(`"${a.command}":`), `${a.id}: ${a.command}`).toBe(true);
		}
	});

	it("knows every command registered anywhere in src/ (ids stay stable for hotkeys)", () => {
		const literal = literalCommandIds();
		const commands = new Set(ACTIONS.filter((a) => a.command).map((a) => a.id));
		for (const [id, file] of literal) expect(commands.has(id), `${id} (${file}) is not in the registry`).toBe(true);
		// External commands are really registered by their owner.
		for (const a of ACTIONS.filter((x) => x.scope === "external" && x.command)) {
			expect(literal.get(a.id)?.replace(/\\/g, "/").endsWith(a.owner!), `${a.id} should be registered in ${a.owner}`).toBe(true);
		}
	});

	it("keeps the command ids of 0.5 (hotkeys)", () => {
		const ids = new Set(ACTIONS.filter((a) => a.command).map((a) => a.id));
		for (const id of [
			"create", "open", "continue-last", "open-library", "import-pdf", "lecture-from-slides", "exercise-page", "exercise-paper", "undo", "redo",
			"fit-width", "add-page", "scan-into", "scan-new", "pen-button-test", "benchmark", "create-stress-test", "export-pdf", "pdf-margins",
			"pdf-update", "pdf-annotations", "timetable", "open-class", "tool-pen", "tool-highlighter", "tool-eraser", "tool-lasso", "tool-shape",
			"tool-text", "shape-line", "shape-arrow", "shape-rectangle", "shape-ellipse", "eraser-stroke", "eraser-segment", "eraser-larger",
			"eraser-smaller", "favourite-1", "favourite-2", "favourite-3", "favourite-4", "favourite-5", "favourite-6", "pen-only", "next-page",
			"previous-page", "delete-selection", "toggle-pages-panel", "toggle-ruler", "pdf-search", "pdf-search-next", "pdf-search-previous",
			"toggle-annotations", "toggle-dim-background", "board-shot", "new-lecture", "loose-sheet", "move-pages", "pdf-side-open",
			"pdf-side-close", "pdf-side-link", "pdf-side-add-page",
			// wave 0.7
			"toggle-page-mode", "go-to-page", "goto-page-number", "recent-pages", "sync-check", "check-integrity",
		]) expect(ids.has(id), id).toBe(true);
	});

	it("places every action somewhere in at least one context and width", () => {
		for (const a of ACTIONS) {
			const found = new Set<string>();
			for (const [, c] of CONTEXTS) for (const w of WIDTHS) for (const p of placementsOf(a.id, c, w)) found.add(p);
			expect(found.size, `${a.id} is not reachable`).toBeGreaterThan(0);
			// A view action that is only on the palette must still have a command.
			if ([...found].every((p) => p === "palette")) expect(a.command, a.id).toBeTruthy();
		}
	});

	it("puts every view action that is not a command on a touch surface (pen and finger reach everything)", () => {
		const touch = new Set(["toolbar", "quick", "context", "options", "favourites", "radial", "sheet", "page"]);
		for (const a of ACTIONS.filter((x) => x.scope === "view")) {
			const found = new Set<string>();
			for (const [, c] of CONTEXTS) for (const w of WIDTHS) for (const p of placementsOf(a.id, c, w)) found.add(p);
			if (!a.command || a.surfaces.some((s) => touch.has(s))) {
				expect([...found].some((p) => touch.has(p)), `${a.id}: ${[...found].join(",")}`).toBe(true);
			}
		}
	});

	it("disables editing actions on a read-only document and keeps reading actions", () => {
		const ro = baseContext({ editable: false, notebook: { pdfPages: true, backgrounds: true } });
		const by = (id: string) => ACTIONS.find((a) => a.id === id)!;
		expect(isEnabled(by("insert-image"), ro)).toBe(false);
		expect(isEnabled(by("page-delete"), ro)).toBe(false);
		expect(isEnabled(by("pdf-search"), ro)).toBe(true);
		expect(isEnabled(by("export-pdf"), ro)).toBe(true);
		expect(isEnabled(by("page-delete"), baseContext({ page: { index: 0, count: 1, background: "none", infinite: false, bookmarked: false } }))).toBe(false);
		expect(isRelevant(by("pdf-search"), baseContext())).toBe(false);
	});

	it("orders contexts from the most specific", () => {
		expect(activeContexts(baseContext())).toEqual([]);
		expect(activeContexts(baseContext({ tool: "lasso", selection: { strokes: 1, elements: 0, images: 0 }, lecture: true }))).toEqual(["selection", "lasso", "lecture"]);
		expect(activeContexts(baseContext({ open: false, lecture: true }))).toEqual([]);
	});
});
