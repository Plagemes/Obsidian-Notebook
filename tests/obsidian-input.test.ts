// wave 0.9: obsidian and input (370 toolbar size, 372 page turner keys, 385 Obsidian bookmarks).
import { describe, expect, it } from "vitest";
import { pageTargetFromEphemeralState, resolvePageTarget } from "../src/integration/page-links";
import { bookmarksInstance, hasBookmark, isBookmarksInstance, pageBookmark } from "../src/integration/bookmark-logic";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { baseContext } from "../src/ui/actions";
import { buildLayout, contextCapacity, toolbarPlan, TOOLBAR_METRICS } from "../src/ui/layout";
import { dialScale, isToolbarSize, toolbarScale, toolsRowWraps } from "../src/ui/toolbar-size";
import { pageKeyAction, shouldTurnPage, takesKey, type KeyScene } from "../src/view/page-keys";

describe("page turner keys (372)", () => {
	it("maps arrows, PageUp / PageDown and space", () => {
		for (const key of ["ArrowRight", "ArrowDown", "PageDown", " "]) expect(pageKeyAction({ key }), key).toBe("next");
		for (const key of ["ArrowLeft", "ArrowUp", "PageUp"]) expect(pageKeyAction({ key }), key).toBe("previous");
		expect(pageKeyAction({ key: " ", shiftKey: true })).toBe("previous");
	});

	it("ignores shortcuts, repeats, composition, handled events and other keys", () => {
		expect(pageKeyAction({ key: "ArrowRight", ctrlKey: true })).toBeNull();
		expect(pageKeyAction({ key: "PageDown", metaKey: true })).toBeNull();
		expect(pageKeyAction({ key: "ArrowLeft", altKey: true })).toBeNull();
		expect(pageKeyAction({ key: "ArrowRight", shiftKey: true })).toBeNull();
		expect(pageKeyAction({ key: "PageDown", repeat: true })).toBeNull();
		expect(pageKeyAction({ key: " ", isComposing: true })).toBeNull();
		expect(pageKeyAction({ key: "ArrowDown", defaultPrevented: true })).toBeNull();
		for (const key of ["a", "Enter", "Escape", "Home", "End", "Tab", "z"]) expect(pageKeyAction({ key }), key).toBeNull();
	});

	const scene: KeyScene = { enabled: true, viewActive: true, targetEditable: false, busy: false, overlayOpen: false };
	it("turns only while the view is active, enabled and nothing else wants the key", () => {
		expect(shouldTurnPage(scene)).toBe(true);
		for (const patch of [{ enabled: false }, { viewActive: false }, { targetEditable: true }, { busy: true }, { overlayOpen: true }]) {
			expect(shouldTurnPage({ ...scene, ...patch }), JSON.stringify(patch)).toBe(false);
		}
	});

	it("lets text fields keep every key and buttons only the space bar", () => {
		const el = (tagName: string, extra: object = {}) => ({ tagName, ...extra });
		expect(takesKey(null, "ArrowDown")).toBe(false);
		for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) expect(takesKey(el(tag), "ArrowDown"), tag).toBe(true);
		expect(takesKey(el("DIV", { isContentEditable: true }), "PageDown")).toBe(true);
		expect(takesKey(el("DIV", { getAttribute: () => "slider" }), "ArrowRight")).toBe(true);
		// A tapped toolbar button keeps the focus: arrows and PageDown must still turn pages, space activates the button.
		expect(takesKey(el("BUTTON"), "ArrowRight")).toBe(false);
		expect(takesKey(el("BUTTON"), "PageDown")).toBe(false);
		expect(takesKey(el("BUTTON"), " ")).toBe(true);
		expect(takesKey(el("DIV"), " ")).toBe(false);
	});
});

describe("toolbar size (370)", () => {
	it("has three sizes, normal by default, and reads only valid values", () => {
		expect(DEFAULT_SETTINGS.toolbarSize).toBe("normal");
		expect(readSettings({ toolbarSize: "large" }).toolbarSize).toBe("large");
		expect(readSettings({ toolbarSize: "huge" }).toolbarSize).toBe("normal");
		expect(readSettings({ toolbarSize: 3 }).toolbarSize).toBe("normal");
		expect(isToolbarSize("compact")).toBe(true);
		expect(isToolbarSize("x")).toBe(false);
		expect(DEFAULT_SETTINGS.pageTurnerKeys).toBe(true);
		expect(readSettings({ pageTurnerKeys: false }).pageTurnerKeys).toBe(false);
	});

	it("scales targets, icons and slots monotonically; normal is the designed 40 px / 44 px slot", () => {
		const [c, n, l] = (["compact", "normal", "large"] as const).map(toolbarScale);
		expect(n).toMatchObject({ target: 40, slot: TOOLBAR_METRICS.slot, dial: 1 });
		expect(c!.target).toBeLessThan(n!.target);
		expect(l!.target).toBeGreaterThan(n!.target);
		expect(l!.icon).toBeGreaterThan(n!.icon);
		expect(l!.slot).toBe(l!.target + 4);
		expect(l!.dial).toBeGreaterThan(1);
	});

	it("keeps the dial inside the view", () => {
		expect(dialScale(1.3, "normal")).toBe(1);
		expect(dialScale(1.3, "large")).toBeCloseTo(1.2);
		expect(dialScale(0.8, "large")).toBe(0.8);
		expect(dialScale(0.2, "large")).toBe(0.6);
		expect(dialScale(2, "compact")).toBeCloseTo(0.9);
	});

	it("wraps the row of tools only when it does not fit", () => {
		expect(toolsRowWraps("normal", 360)).toBe(false);
		expect(toolsRowWraps("large", 360)).toBe(true);
		expect(toolsRowWraps("large", 800)).toBe(false);
	});

	it("budgets fewer quick slots and context buttons for bigger buttons, the same as before at normal", () => {
		expect(toolbarPlan(1000)).toEqual(toolbarPlan(1000, 44));
		expect(toolbarPlan(1280, 52).quickSlots).toBeLessThanOrEqual(toolbarPlan(1280, 44).quickSlots);
		expect(toolbarPlan(1280, 40).quickSlots).toBeGreaterThanOrEqual(toolbarPlan(1280, 44).quickSlots);
		expect(contextCapacity(412, 52)).toBeLessThanOrEqual(contextCapacity(412, 44));
		const c = baseContext();
		expect(buildLayout(c, 800, {}, 0).quick).toEqual(buildLayout(c, 800, {}, 0, undefined, 44).quick);
	});
});

describe("Obsidian bookmarks (385)", () => {
	it("builds a file bookmark whose subpath names the page by id", () => {
		expect(pageBookmark("Notebooks/Physics.notebook", 3, "abc_1", "Physics, p. 3", 1700000000000)).toEqual({
			type: "file", ctime: 1700000000000, path: "Notebooks/Physics.notebook", subpath: "#p3&id=abc_1", title: "Physics, p. 3",
		});
		expect(pageBookmark("a.notebook", 2, null, "x").ctime).toBeGreaterThan(0);
		expect(pageBookmark("a.notebook", 2, null, "x").subpath).toBe("#p2");
	});

	it("opening such a bookmark lands on the page: the ephemeral subpath resolves by id, also after pages moved", () => {
		const b = pageBookmark("Physics.notebook", 3, "pg3", "t");
		const target = pageTargetFromEphemeralState({ subpath: b.subpath });
		expect(target).toEqual({ page: 3, pageId: "pg3" });
		const pages = [{ id: "pg0" }, { id: "pg3" }, { id: "pg1" }];
		expect(resolvePageTarget(pages, target!)).toEqual({ index: 1 });
		expect(resolvePageTarget(pages.slice(2), target!)).toEqual({ missing: "deleted" });
	});

	it("finds an existing bookmark, also inside groups, and ignores other shapes", () => {
		const items = [
			{ type: "file", path: "x.md", subpath: "" },
			{ type: "group", items: [{ type: "file", path: "P.notebook", subpath: "#p3&id=pg3" }] },
			null, 4,
		];
		expect(hasBookmark(items, "P.notebook", "#p3&id=pg3")).toBe(true);
		expect(hasBookmark(items, "P.notebook", "#p4&id=pg4")).toBe(false);
		expect(hasBookmark(items, "x.md", "")).toBe(true);
		expect(hasBookmark(undefined, "x.md", "")).toBe(false);
	});

	it("feature-detects the core plugin and never throws", () => {
		const addItem = () => undefined;
		const app = (internalPlugins: unknown) => ({ internalPlugins }) as never;
		expect(Reflect.get(bookmarksInstance(app({ getPluginById: () => ({ enabled: true, instance: { addItem } }) })) ?? {}, "addItem")).toBe(addItem);
		expect(bookmarksInstance(app({ getPluginById: () => ({ enabled: false, instance: { addItem } }) }))).toBeNull();
		expect(bookmarksInstance(app({ getPluginById: () => ({ instance: { addItem } }) }))).toBeNull();
		expect(bookmarksInstance(app({ getPluginById: () => ({ enabled: true, instance: {} }) }))).toBeNull();
		expect(bookmarksInstance(app({ getPluginById: () => undefined }))).toBeNull();
		expect(bookmarksInstance(app({ getPluginById: () => { throw new Error("x"); } }))).toBeNull();
		expect(bookmarksInstance(app(undefined))).toBeNull();
		expect(isBookmarksInstance({ addItem })).toBe(true);
		expect(isBookmarksInstance(null)).toBe(false);
	});
});
