import { describe, expect, it } from "vitest";
import {
	nearbyPapers, normaliseSmartAddStore, parseSmartAddHistory, pushSmartAdd, rankSmartAdd, rememberSmartAdd, SMART_ADD_HISTORY_MAX,
	SMART_ADD_MAX_NOTEBOOKS, type SmartAddInput, type SmartAddStore,
} from "../src/model/smart-add";

const base: SmartAddInput = { paper: "ruled", hasBackground: false, slide: null, exercisePaper: "grid", history: [] };
const ids = (i: SmartAddInput) => rankSmartAdd(i).map((c) => c.id);

describe("rankSmartAdd", () => {
	it("is deterministic and never empty", () => {
		expect(rankSmartAdd(base)).toEqual(rankSmartAdd(base));
		expect(rankSmartAdd(base).length).toBeGreaterThanOrEqual(2);
		expect(rankSmartAdd(base, 1)[0]!.id).toBe("same");
	});

	it("puts the same paper first on a plain page, then the exercise page", () => {
		expect(ids(base)).toEqual(["same", "exercise", "blank"]);
	});

	it("puts the slide page first when a PDF is beside the notes", () => {
		const r = rankSmartAdd({ ...base, slide: 4 });
		expect(r[0]!.id).toBe("slide");
		expect(r.some((c) => c.id === "same")).toBe(true);
	});

	it("favours the exercise page on a PDF page", () => {
		expect(ids({ ...base, hasBackground: true })[0]).toBe("exercise");
	});

	it("offers the paper used last (Cornell) and ranks it above blank", () => {
		const r = ids({ ...base, history: [{ id: "recent-paper", paper: "cornell" }] });
		expect(r).toEqual(["same", "recent-paper", "exercise"]);
	});

	it("learns: repeated blank choices lift blank", () => {
		const history = [{ id: "blank" as const, paper: "blank" as const }, { id: "blank" as const, paper: "blank" as const }, { id: "blank" as const, paper: "blank" as const }];
		const r = ids({ ...base, history });
		expect(r.indexOf("blank")).toBeLessThan(r.indexOf("exercise"));
	});

	it("merges candidates that make the same page and keeps the same paper reachable", () => {
		// exercise paper equals this page's paper: one choice, not two
		const r = rankSmartAdd({ ...base, paper: "grid" });
		expect(r.filter((c) => c.paper === "grid")).toHaveLength(1);
		const lecture = rankSmartAdd({ ...base, paper: "grid", hasBackground: true });
		expect(lecture.some((c) => c.paper === "grid")).toBe(true);
	});

	it("does not offer blank on a blank page", () => {
		expect(ids({ ...base, paper: "blank" })).not.toContain("blank");
	});

	it("respects the limit", () => {
		expect(rankSmartAdd({ ...base, slide: 1, history: [{ id: "recent-paper", paper: "cornell" }] }, 2)).toHaveLength(2);
	});
});

describe("notebook context", () => {
	it("offers the paper of neighbouring pages when there is no history", () => {
		expect(ids({ ...base, nearbyPapers: ["ruled", "cornell"] })).toEqual(["same", "recent-paper", "exercise"]);
		expect(rankSmartAdd({ ...base, nearbyPapers: ["cornell"] }).find((c) => c.id === "recent-paper")?.paper).toBe("cornell");
	});

	it("lists nearby papers nearest first without repeats", () => {
		const pages = ["grid", "ruled", "cornell", "ruled", "grid"].map((kind) => ({ paper: { kind: kind as "grid" } }));
		expect(nearbyPapers(pages, 2)).toEqual(["ruled", "grid"]);
		expect(nearbyPapers(pages.slice(0, 1), 0)).toEqual([]);
	});
});

describe("history", () => {
	it("pushes newest first and bounds the length", () => {
		let h: ReturnType<typeof pushSmartAdd> = [];
		for (let i = 0; i < SMART_ADD_HISTORY_MAX + 5; i++) h = pushSmartAdd(h, { id: i % 2 ? "same" : "blank", paper: "blank" });
		expect(h).toHaveLength(SMART_ADD_HISTORY_MAX);
		expect(pushSmartAdd(h, { id: "slide" })[0]).toEqual({ id: "slide" });
	});

	it("drops invalid stored entries without throwing", () => {
		expect(parseSmartAddHistory("x")).toEqual([]);
		expect(parseSmartAddHistory([null, 3, { id: "nope" }, { id: "same", paper: "bogus" }, { id: "exercise", paper: "grid" }]))
			.toEqual([{ id: "same" }, { id: "exercise", paper: "grid" }]);
	});
});

describe("the per-device store", () => {
	it("keeps a history per notebook, newest first", () => {
		let s = rememberSmartAdd({}, "nb1", { id: "same", paper: "ruled" }, 10);
		s = rememberSmartAdd(s, "nb1", { id: "exercise" }, 20);
		s = rememberSmartAdd(s, "nb2", { id: "blank" }, 30);
		expect(s.nb1!.history).toEqual([{ id: "exercise" }, { id: "same", paper: "ruled" }]);
		expect(s.nb2!.history).toEqual([{ id: "blank" }]);
	});

	it("is capped: the least recently used notebooks are forgotten, each history stays bounded", () => {
		let s: SmartAddStore = {};
		for (let i = 0; i < SMART_ADD_MAX_NOTEBOOKS + 25; i++) s = rememberSmartAdd(s, `nb${i}`, { id: "blank" }, i + 1);
		expect(Object.keys(s)).toHaveLength(SMART_ADD_MAX_NOTEBOOKS);
		expect(s.nb0).toBeUndefined();
		expect(s[`nb${SMART_ADD_MAX_NOTEBOOKS + 24}`]).toBeDefined();
		for (let i = 0; i < SMART_ADD_HISTORY_MAX + 5; i++) s = rememberSmartAdd(s, "busy", { id: i % 2 ? "same" : "blank" }, 1000 + i);
		expect(s.busy!.history).toHaveLength(SMART_ADD_HISTORY_MAX);
		expect(Object.keys(s)).toHaveLength(SMART_ADD_MAX_NOTEBOOKS);
	});

	it("starts from the history an older version kept in its own key", () => {
		const s = rememberSmartAdd({}, "old", { id: "slide" }, 5, [{ id: "exercise" }, { id: "same", paper: "grid" }]);
		expect(s.old!.history).toEqual([{ id: "slide" }, { id: "exercise" }, { id: "same", paper: "grid" }]);
		// Once the notebook is in the store the legacy value is not used again.
		expect(rememberSmartAdd(s, "old", { id: "blank" }, 6, [{ id: "exercise" }]).old!.history[1]).toEqual({ id: "slide" });
	});

	it("reads damaged data as empty or drops the bad parts, never throws", () => {
		for (const junk of [null, undefined, 3, "x", [], { a: 1 }]) expect(normaliseSmartAddStore(junk)).toEqual({});
		const s = normaliseSmartAddStore({
			"bad id!": { at: 1, history: [{ id: "same" }] }, ok: { at: 2, history: [{ id: "nope" }, { id: "same" }] },
			empty: { at: 3, history: [] }, str: "x", noAt: { history: [{ id: "blank" }] },
		});
		expect(Object.keys(s).sort()).toEqual(["noAt", "ok"]);
		expect(s.ok!.history).toEqual([{ id: "same" }]);
		expect(rememberSmartAdd({}, "bad id!", { id: "same" }, 1)).toEqual({});
	});
});
