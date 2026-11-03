import { describe, expect, it } from "vitest";
import { nearbyPapers, parseSmartAddHistory, pushSmartAdd, rankSmartAdd, SMART_ADD_HISTORY_MAX, type SmartAddInput } from "../src/model/smart-add";

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
