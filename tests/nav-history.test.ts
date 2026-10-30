import { describe, expect, it } from "vitest";
import { NavHistory, NAV_HISTORY_CAP, samePlace, type NavPlace } from "../src/model/nav-history";
import { mouseNavDirection, NavController, type NavDeps } from "../src/view/nav-controller";
import { ACTIONS, baseContext, isEnabled, isRelevant } from "../src/ui/actions";
import { buildLayout, buildSheet } from "../src/ui/layout";
import { statusBarText } from "../src/view/status-bar-logic";

const p = (page: number, path = "A.notebook"): NavPlace => ({ path, pageId: `${path}#${page}`, page });
const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
const pages = (h: NavHistory) => h.snapshot().places.map((x) => `${x.path[0]}${x.page}`);

describe("NavHistory (roadmap 18)", () => {
	it("starts empty: nothing to go back or forward to", () => {
		const h = new NavHistory();
		expect([h.canBack, h.canForward, h.length]).toEqual([false, false, 0]);
		expect(h.back(p(1))).toBeNull();
		expect(h.forward(p(1))).toBeNull();
	});

	it("records a jump as the place left and the place reached", () => {
		const h = new NavHistory();
		h.jump(p(1), p(7));
		expect(pages(h)).toEqual(["A1", "A7"]);
		expect([h.canBack, h.canForward]).toEqual([true, false]);
		expect(h.back(p(7))).toEqual(p(1));
		expect([h.canBack, h.canForward]).toEqual([false, true]);
		expect(h.forward(p(1))).toEqual(p(7));
	});

	it("without a known place (coming from the library) the first jump is a single entry", () => {
		const h = new NavHistory();
		h.jump(null, p(3));
		expect(pages(h)).toEqual(["A3"]);
		expect(h.canBack).toBe(false);
	});

	it("ignores a jump to the page already in view", () => {
		const h = new NavHistory();
		h.jump(p(2), p(2));
		expect(h.length).toBe(0);
		h.jump(p(2), p(9));
		h.jump(p(9), p(9));
		expect(pages(h)).toEqual(["A2", "A9"]);
	});

	it("goes back to the place actually left, not the one jumped to", () => {
		const h = new NavHistory();
		h.jump(p(1), p(10)); // A1 -> A10
		h.jump(p(14), p(30)); // scrolled on to 14, then jumped to 30
		expect(pages(h)).toEqual(["A1", "A14", "A30"]);
		expect(h.back(p(30))).toEqual(p(14));
		expect(h.back(p(14))).toEqual(p(1));
	});

	it("keeps the place the reader scrolled to, so Forward returns to it", () => {
		const h = new NavHistory();
		h.jump(p(1), p(10));
		// back from page 12 (scrolled on from 10): Forward must return to 12
		expect(h.back(p(12))).toEqual(p(1));
		expect(h.forward(p(1))).toEqual(p(12));
	});

	it("a new jump after going back discards the forward history, as in a browser", () => {
		const h = new NavHistory();
		h.jump(p(1), p(5));
		h.jump(p(5), p(9));
		h.back(p(9));
		h.back(p(5));
		expect(h.canForward).toBe(true);
		h.jump(p(1), p(20));
		expect(pages(h)).toEqual(["A1", "A20"]);
		expect(h.canForward).toBe(false);
	});

	it("spans notebooks", () => {
		const h = new NavHistory();
		h.jump(p(4, "A.notebook"), p(2, "B.notebook"));
		h.jump(p(2, "B.notebook"), p(8, "C.notebook"));
		expect(h.back(p(8, "C.notebook"))).toEqual(p(2, "B.notebook"));
		expect(h.back(p(2, "B.notebook"))).toEqual(p(4, "A.notebook"));
		expect(h.back(p(4, "A.notebook"))).toBeNull();
	});

	it("is capped: the oldest places go and the reader keeps their position", () => {
		const h = new NavHistory(5);
		for (let i = 1; i <= 20; i++) h.jump(p(i), p(i + 1));
		expect(h.length).toBe(5);
		expect(pages(h)).toEqual(["A17", "A18", "A19", "A20", "A21"]);
		expect(h.back(p(21))).toEqual(p(20));
		expect(NAV_HISTORY_CAP).toBeGreaterThanOrEqual(20);
		expect(new NavHistory().cap).toBe(NAV_HISTORY_CAP);
	});

	it("merges neighbours that are the same place", () => {
		const h = new NavHistory();
		h.jump(p(1), p(5));
		// the reader scrolled back to page 1 and jumps again to 5
		h.jump(p(1), p(5));
		expect(pages(h)).toEqual(["A1", "A5"]);
		// going "back" from a place that is the previous entry does not strand the reader
		expect(h.back(p(1))).toBeNull();
	});

	it("drops places that cannot be shown and keeps the position", () => {
		const h = new NavHistory();
		h.jump(p(1), p(5));
		h.jump(p(5), p(9)); // A1 A5 A9, at A9
		h.drop(p(5));
		expect(pages(h)).toEqual(["A1", "A9"]);
		expect(h.back(p(9))).toEqual(p(1));
		h.drop(p(1)); // the place we are going to is gone
		h.drop(p(9));
		expect(h.length).toBe(0);
		expect(h.canBack).toBe(false);
	});

	it("follows a renamed notebook and forgets a deleted one", () => {
		const h = new NavHistory();
		h.jump(p(1, "A.notebook"), p(2, "B.notebook"));
		h.jump(p(2, "B.notebook"), p(3, "A.notebook"));
		h.rename("A.notebook", "Z.notebook");
		expect(h.snapshot().places.map((x) => x.path)).toEqual(["Z.notebook", "B.notebook", "Z.notebook"]);
		h.removeNotebook("Z.notebook");
		expect(h.snapshot().places.map((x) => x.path)).toEqual(["B.notebook"]);
		expect(h.canBack).toBe(false);
	});

	it("identifies a place by notebook and page id, not by number", () => {
		expect(samePlace({ path: "A", pageId: "x", page: 3 }, { path: "A", pageId: "x", page: 5 })).toBe(true);
		expect(samePlace({ path: "A", pageId: "x", page: 3 }, { path: "B", pageId: "x", page: 3 })).toBe(false);
	});
});

function fakeDeps(over: Partial<NavDeps> = {}): { deps: NavDeps; opened: NavPlace[]; here: { value: NavPlace | null }; clock: { t: number } } {
	const opened: NavPlace[] = [];
	const here = { value: null as NavPlace | null };
	const clock = { t: 1000 };
	const deps: NavDeps = {
		here: () => here.value,
		exists: async () => true,
		open: async (place) => {
			opened.push(place);
			here.value = place;
		},
		now: () => clock.t,
		...over,
	};
	return { deps, opened, here, clock };
}

describe("NavController", () => {
	it("goes back and forward through the jumps and opens each place", async () => {
		const { deps, opened, here } = fakeDeps();
		const nav = new NavController(deps);
		here.value = p(1);
		nav.arrive(p(1), p(8));
		here.value = p(8);
		nav.arrive(p(8), p(3, "B.notebook"));
		here.value = p(3, "B.notebook");
		expect(await nav.go(-1)).toBe(true);
		expect(last(opened)).toEqual(p(8));
		expect(await nav.go(-1)).toBe(true);
		expect(last(opened)).toEqual(p(1));
		expect(await nav.go(-1)).toBe(false);
		expect(await nav.go(1)).toBe(true);
		expect(last(opened)).toEqual(p(8));
	});

	it("does not record the arrival that Back asked for, but records the next jump", async () => {
		const { deps, here } = fakeDeps();
		const nav = new NavController(deps);
		nav.arrive(p(1), p(8));
		here.value = p(8);
		await nav.go(-1); // opens A1
		nav.arrive(null, p(1)); // the view reports the arrival of the place Back opened
		expect(nav.history.snapshot().places.length).toBe(2);
		expect(nav.canForward).toBe(true);
		nav.arrive(p(1), p(20)); // a real jump
		expect(nav.canForward).toBe(false);
		expect(last(nav.history.snapshot().places)).toEqual(p(20));
	});

	it("treats an arrival that comes too late as a new jump", async () => {
		const { deps, here, clock } = fakeDeps();
		const nav = new NavController(deps);
		nav.arrive(p(1), p(8));
		here.value = p(8);
		await nav.go(-1);
		clock.t += 60_000;
		nav.arrive(p(1), p(1, "B.notebook"));
		expect(last(nav.history.snapshot().places)).toEqual(p(1, "B.notebook"));
	});

	it("shown() ends the wait for an arrival when no other view opens", async () => {
		const { deps, here } = fakeDeps();
		const nav = new NavController(deps);
		nav.arrive(p(1), p(8));
		here.value = p(8);
		await nav.go(-1);
		nav.shown();
		nav.arrive(p(1), p(1, "B.notebook")); // not swallowed even though it is the expected place's neighbour
		expect(last(nav.history.snapshot().places)).toEqual(p(1, "B.notebook"));
	});

	it("skips places that no longer exist and removes them", async () => {
		const gone = new Set(["A.notebook#5"]);
		const { deps, opened, here } = fakeDeps({ exists: async (pl) => !gone.has(pl.pageId) });
		const nav = new NavController(deps);
		nav.arrive(p(1), p(5));
		nav.arrive(p(5), p(9));
		here.value = p(9);
		expect(await nav.go(-1)).toBe(true);
		expect(opened).toEqual([p(1)]);
		expect(nav.history.snapshot().places.map((x) => x.page)).toEqual([1, 9]);
	});

	it("returns false when every earlier place is gone", async () => {
		const { deps, here } = fakeDeps({ exists: async (pl) => pl.page >= 9 });
		const nav = new NavController(deps);
		nav.arrive(p(1), p(9));
		here.value = p(9);
		expect(await nav.go(-1)).toBe(false);
		expect(nav.canBack).toBe(false);
	});

	it("uses the last place seen when the view that jumps has just opened", () => {
		const { deps } = fakeDeps();
		const nav = new NavController(deps);
		nav.seen(p(6, "A.notebook"));
		nav.arrive(null, p(1, "B.notebook"));
		expect(nav.history.snapshot().places).toEqual([p(6, "A.notebook"), p(1, "B.notebook")]);
	});

	it("ignores a second request while one is running", async () => {
		let release!: () => void;
		const { deps, here } = fakeDeps({ open: () => new Promise<void>((r) => (release = r)) });
		const nav = new NavController(deps);
		nav.arrive(p(1), p(5));
		nav.arrive(p(5), p(9));
		here.value = p(9);
		const first = nav.go(-1);
		expect(await nav.go(-1)).toBe(false);
		release();
		expect(await first).toBe(true);
	});

	it("tells listeners when the history changes", async () => {
		const { deps } = fakeDeps();
		const nav = new NavController(deps);
		let n = 0;
		const stop = nav.onChange(() => n++);
		nav.arrive(p(1), p(5));
		expect(n).toBe(1);
		nav.renamed("A.notebook", "B.notebook");
		nav.removed("B.notebook");
		expect(n).toBe(3);
		stop();
		nav.arrive(p(1), p(5));
		expect(n).toBe(3);
	});
});

describe("Back and Forward in the action registry", () => {
	const by = (id: string) => ACTIONS.find((a) => a.id === id)!;

	it("registers both as commands with a quick slot and the page sheet", () => {
		for (const id of ["nav-back", "nav-forward"]) {
			const a = by(id);
			expect(a.command).toBeTruthy();
			expect(a.surfaces).toEqual(expect.arrayContaining(["quick", "page"]));
			expect(a.readOnly).toBe(true);
		}
	});

	it("hides them until there is a history, enables only the direction that has somewhere to go", () => {
		expect(isRelevant(by("nav-back"), baseContext())).toBe(false);
		expect(isRelevant(by("nav-back"), baseContext({ nav: { back: false, forward: false } }))).toBe(false);
		const onlyBack = baseContext({ nav: { back: true, forward: false } });
		expect(isRelevant(by("nav-forward"), onlyBack)).toBe(true);
		expect(isEnabled(by("nav-back"), onlyBack)).toBe(true);
		expect(isEnabled(by("nav-forward"), onlyBack)).toBe(false);
	});

	it("shows them in a quick slot on a tablet and desktop, in the page sheet everywhere", () => {
		const c = baseContext({ nav: { back: true, forward: false } });
		expect(buildLayout(c, 1280, {}, 0).quick).toEqual(expect.arrayContaining(["nav-back", "nav-forward"]));
		expect(buildLayout(c, 360, {}, 0).quick).toEqual([]);
		const label = (a: { id: string }) => a.id;
		const page = buildSheet(c, { kind: "page", usage: {}, now: 0, label });
		expect(page[0]?.id).toBe("navigate");
		expect(page[0]?.actions.map((a) => a.id)).toEqual(expect.arrayContaining(["nav-back", "nav-forward"]));
	});

	it("maps the mouse side buttons", () => {
		expect([0, 1, 2, 3, 4].map(mouseNavDirection)).toEqual([0, 0, 0, -1, 1]);
	});
});

describe("status bar text (roadmap O15)", () => {
	it("shows the page and the save state", () => {
		expect(statusBarText("p. 3/12", "Saved")).toBe("p. 3/12 · Saved");
		expect(statusBarText("p. 1/1", "")).toBe("p. 1/1");
	});
});
