import { describe, expect, it } from "vitest";
import {
	addPreset, allPresets, ALL_AVAILABLE, BUILTIN_PRESETS, captureArrangement, cleanPanels, findPreset, matches, MAX_PRESETS, NO_PANELS,
	normaliseActivePreset, normalisePresets, planPanels, presetName, removePreset, renamePreset, splitOpen, updatePreset, wantedState,
	type PanelState, type WorkspacePreset,
} from "../src/view/workspace-presets";

const state = (open: Array<keyof PanelState>): PanelState => ({ ...NO_PANELS, ...Object.fromEntries(open.map((k) => [k, true])) });
const ctx = { narrow: false, available: ALL_AVAILABLE };

describe("built-in presets", () => {
	it("Lecture is slides + outline, Study is reference + related, Focus closes everything", () => {
		expect(wantedState(findPreset([], "lecture")!)).toEqual(state(["pdf", "outline"]));
		expect(wantedState(findPreset([], "study")!)).toEqual(state(["reference", "related"]));
		expect(wantedState(findPreset([], "focus")!)).toEqual(NO_PANELS);
		expect(BUILTIN_PRESETS.map((p) => p.id)).toEqual(["lecture", "study", "focus"]);
	});

	it("translates the built-in names and keeps the saved ones as typed", () => {
		const tr = (k: string): string => `T:${k}`;
		expect(presetName(findPreset([], "focus")!, tr)).toBe("T:workspace.builtin.focus");
		expect(presetName({ id: "ws-1", name: "My class", panels: [] }, tr)).toBe("My class");
	});
});

describe("panels list", () => {
	it("keeps the fixed order, drops repeats and unknown ids, and lets the outline win over the plain page panel", () => {
		expect(cleanPanels(["related", "pdf", "pdf", "nope", 3])).toEqual(["pdf", "related"]);
		expect(cleanPanels(["navigator", "outline"])).toEqual(["outline"]);
		expect(cleanPanels("pdf")).toEqual([]);
	});
});

describe("lenient read", () => {
	it("drops bad entries, built-in and repeated ids, and caps the list", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ id: `ws-${i}`, name: `P${i}`, panels: ["pdf"] }));
		const out = normalisePresets([{ id: "lecture", name: "x", panels: [] }, { id: "ws-a", name: " ", panels: [] }, { id: "bad id!", name: "n", panels: [] }, null, 5, { id: "ws-b", name: "Ok", panels: ["minimap", "zzz"], profile: "study" }, { id: "ws-b", name: "Twice", panels: [] }, ...many]);
		expect(out[0]).toEqual({ id: "ws-b", name: "Ok", panels: ["minimap"], profile: "study" });
		expect(out.length).toBe(MAX_PRESETS);
		expect(new Set(out.map((p) => p.id)).size).toBe(out.length);
	});

	it("returns nothing for data that is not a list", () => {
		expect(normalisePresets(undefined)).toEqual([]);
		expect(normalisePresets({ a: 1 })).toEqual([]);
	});

	it("trims and bounds names", () => {
		const out = normalisePresets([{ id: "ws-a", name: `  ${"x".repeat(80)}  `, panels: [] }]);
		expect(out[0]!.name.length).toBe(30);
	});

	it("the active id must exist", () => {
		const custom = normalisePresets([{ id: "ws-a", name: "A", panels: [] }]);
		expect(normaliseActivePreset("ws-a", custom)).toBe("ws-a");
		expect(normaliseActivePreset("focus", custom)).toBe("focus");
		expect(normaliseActivePreset("ws-gone", custom)).toBe("");
		expect(normaliseActivePreset(7, custom)).toBe("");
	});
});

describe("plan", () => {
	it("opens what is missing and closes what is extra, leaving the rest alone", () => {
		const plan = planPanels(wantedState(findPreset([], "lecture")!), state(["pdf", "minimap", "related"]), ctx);
		expect(plan).toEqual({ close: ["minimap", "related"], open: ["outline"], skipped: [] });
	});

	it("Focus closes every open panel and opens none", () => {
		const plan = planPanels(NO_PANELS, state(["pdf", "reference", "outline", "minimap", "related"]), ctx);
		expect(plan.close).toEqual(["pdf", "reference", "outline", "minimap", "related"]);
		expect(plan.open).toEqual([]);
	});

	it("the same arrangement is an empty plan", () => {
		const cur = state(["pdf", "outline"]);
		expect(planPanels(cur, cur, ctx)).toEqual({ close: [], open: [], skipped: [] });
	});

	it("swaps the faces of the page panel", () => {
		expect(planPanels(state(["navigator"]), state(["outline"]), ctx)).toEqual({ close: ["outline"], open: ["navigator"], skipped: [] });
	});

	it("a panel the place does not offer is left alone and named", () => {
		const plan = planPanels(state(["minimap"]), NO_PANELS, { narrow: false, available: { ...ALL_AVAILABLE, minimap: false } });
		expect(plan).toEqual({ close: [], open: [], skipped: ["minimap"] });
		// and a closed-by-setting panel that is currently "open" is not closed either
		expect(planPanels(NO_PANELS, state(["minimap"]), { narrow: false, available: { ...ALL_AVAILABLE, minimap: false } }).close).toEqual([]);
	});

	it("on a phone the floating panels are skipped and the slides pane stays", () => {
		const plan = planPanels(state(["pdf", "reference", "minimap", "related", "outline"]), NO_PANELS, { narrow: true, available: ALL_AVAILABLE });
		expect(plan.open).toEqual(["pdf"]);
		expect(plan.skipped).toEqual(["reference", "outline", "minimap", "related"]);
	});

	it("on a phone without slides the outline drawer is kept", () => {
		const plan = planPanels(state(["outline"]), NO_PANELS, { narrow: true, available: ALL_AVAILABLE });
		expect(plan).toEqual({ close: [], open: ["outline"], skipped: [] });
	});

	it("on a phone a panel wanted closed is still closed, and one wanted open that cannot show stays as it is", () => {
		expect(planPanels(NO_PANELS, state(["minimap", "related"]), { narrow: true, available: ALL_AVAILABLE }).close).toEqual(["minimap", "related"]);
		const keep = planPanels(state(["minimap"]), state(["minimap"]), { narrow: true, available: ALL_AVAILABLE });
		expect(keep).toEqual({ close: [], open: [], skipped: ["minimap"] });
	});
});

describe("file pickers", () => {
	it("opens panels that need no file at once and asks for one file at a time", () => {
		expect(splitOpen(["pdf", "reference", "outline", "related"])).toEqual({ now: ["outline", "related"], ask: "pdf", later: ["reference"] });
		expect(splitOpen([])).toEqual({ now: [], ask: null, later: [] });
	});
});

describe("saving", () => {
	it("captures the open panels and the profile", () => {
		const p = captureArrangement(state(["reference", "minimap"]), "ws-x", "  Reading  ", "study");
		expect(p).toEqual({ id: "ws-x", name: "Reading", panels: ["reference", "minimap"], profile: "study" });
		expect(captureArrangement(state([]), "ws-y", "Bare", "").profile).toBeUndefined();
	});

	it("adds, updates, renames and removes without touching the input", () => {
		const first = addPreset([], "My class", state(["pdf"]), "", "ws-1")!;
		expect(first.id).toBe("ws-1");
		const frozen = Object.freeze(first.presets.map((p) => Object.freeze({ ...p }))) as WorkspacePreset[];
		const upd = updatePreset(frozen, "ws-1", state(["outline", "minimap"]), "lecture");
		expect(upd[0]).toEqual({ id: "ws-1", name: "My class", panels: ["outline", "minimap"], profile: "lecture" });
		expect(renamePreset(upd, "ws-1", "  New  ")[0]!.name).toBe("New");
		expect(renamePreset(upd, "ws-1", "   ")[0]!.name).toBe("My class");
		expect(removePreset(upd, "ws-1")).toEqual([]);
		expect(frozen[0]!.panels).toEqual(["pdf"]);
	});

	it("refuses an empty name and a full list", () => {
		expect(addPreset([], "  ", NO_PANELS, "")).toBeNull();
		const full = Array.from({ length: MAX_PRESETS }, (_, i) => ({ id: `ws-${i}`, name: `P${i}`, panels: [] }));
		expect(addPreset(full, "One more", NO_PANELS, "")).toBeNull();
	});

	it("the listed presets are the built-in ones first, then the saved ones, as copies", () => {
		const custom: WorkspacePreset[] = [{ id: "ws-1", name: "A", panels: ["pdf"] }];
		const all = allPresets(custom);
		expect(all.map((p) => p.id)).toEqual(["lecture", "study", "focus", "ws-1"]);
		all[3]!.panels.push("minimap");
		expect(custom[0]!.panels).toEqual(["pdf"]);
	});
});

describe("matches", () => {
	it("holds when every panel the place offers is as the preset wants", () => {
		const lecture = findPreset([], "lecture")!;
		expect(matches(lecture, state(["pdf", "outline"]))).toBe(true);
		expect(matches(lecture, state(["pdf", "outline", "minimap"]))).toBe(false);
		expect(matches(lecture, state(["pdf", "outline", "minimap"]), { ...ALL_AVAILABLE, minimap: false })).toBe(true);
	});
});
