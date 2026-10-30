// wave 0.10: tabs of open notebooks (363) and automatic line break (353): pure logic.
import { describe, expect, it } from "vitest";
import { LineBreaker, lineBreakTarget, LINE_BREAK_DELAY_MS, LINE_BREAK_LEFT_INSET, type LineBreakClock, type LineBreakInput } from "../src/ink/line-break";
import { layoutPagesHorizontal } from "../src/ink/page-mode";
import type { Viewport } from "../src/ink/viewport";
import { readSettings, DEFAULT_SETTINGS } from "../src/settings";
import { actionById } from "../src/ui/actions";
import { neighbourTab, tabLabels, TabSwipe, TAB_SWIPE_DISTANCE } from "../src/ui/tabs";
import { MM } from "../src/model/types";

const box = { x: 0, y: 0, width: 595, height: 842 };
const ruled = { kind: "ruled" as const, spacing: 8 * MM };
const view = { width: 600, height: 800 };

function input(over: Partial<LineBreakInput> = {}): LineBreakInput {
	// Zoomed in 2x, scrolled so that page x 280 is at the left edge: the right edge of the view shows page x ~580.
	return { tipX: 570, tipY: 100, box, paper: ruled, viewport: { scale: 2, offsetX: -560, offsetY: 16 }, view, ...over };
}

describe("lineBreakTarget (353)", () => {
	it("puts the page left edge at the inset and keeps the next line one line height below the pen", () => {
		const target = lineBreakTarget(input())!;
		expect(target.scale).toBe(2);
		expect(target.offsetX).toBeCloseTo(LINE_BREAK_LEFT_INSET);
		const nextLine = (Math.floor(100 / ruled.spacing) + 1) * ruled.spacing;
		const tipScreen = 100 * 2 + 16;
		const nextScreen = nextLine * 2 + target.offsetY;
		expect(nextScreen - tipScreen).toBeLessThanOrEqual(ruled.spacing * 2);
		expect(nextScreen).toBeGreaterThan(tipScreen);
		expect(target.offsetY).toBe(16); // vertical position unchanged: the line is not near the bottom
	});

	it("works on grid paper and ignores blank, dotted and other papers", () => {
		expect(lineBreakTarget(input({ paper: { kind: "grid", spacing: 14 } }))).not.toBeNull();
		for (const kind of ["blank", "dotted", "millimetre", "music", "cornell"] as const) {
			expect(lineBreakTarget(input({ paper: { kind, spacing: 14 } }))).toBeNull();
		}
	});

	it("does nothing unless the stroke ended in the right band of the visible area", () => {
		expect(lineBreakTarget(input({ tipX: 400 }))).toBeNull(); // screen x 240 of 600
		expect(lineBreakTarget(input({ tipX: 560 }))).not.toBeNull(); // screen x 560 = 93%
	});

	it("does nothing when the whole page width fits (nothing to scroll sideways)", () => {
		expect(lineBreakTarget(input({ viewport: { scale: 0.9, offsetX: 16, offsetY: 16 }, tipX: 560 }))).toBeNull();
	});

	it("does nothing when the next line is off the page (the next-page feature owns that)", () => {
		expect(lineBreakTarget(input({ tipY: 830 }))).toBeNull();
	});

	it("moves up as well when the next line would sit in the bottom band", () => {
		const v: Viewport = { scale: 2, offsetX: -560, offsetY: 0 };
		const t = lineBreakTarget(input({ tipY: 380, viewport: v }))!; // tip at screen y 760 of 800
		expect(t.offsetY).toBeLessThan(0);
		const nextLine = (Math.floor(380 / ruled.spacing) + 1) * ruled.spacing;
		expect(nextLine * 2 + t.offsetY).toBeCloseTo(800 * 0.4);
	});

	it("uses the page box offset (page mode: pages side by side)", () => {
		const layout = layoutPagesHorizontal([box, box]);
		const second = layout.boxes[1]!;
		const v: Viewport = { scale: 2, offsetX: -(second.x + 280) * 2, offsetY: 16 };
		const t = lineBreakTarget(input({ box: second, viewport: v }))!;
		// Page x 0 of the second page is what lands at the inset.
		expect(second.x * t.scale + t.offsetX).toBeCloseTo(LINE_BREAK_LEFT_INSET);
	});

	it("rejects non-finite input", () => {
		expect(lineBreakTarget(input({ tipX: NaN }))).toBeNull();
		expect(lineBreakTarget(input({ view: { width: 0, height: 0 } }))).toBeNull();
	});
});

class FakeClock implements LineBreakClock {
	time = 0;
	private id = 0;
	private timers = new Map<number, { at: number; fn: () => void }>();
	private frames = new Map<number, () => void>();
	now() { return this.time; }
	setTimeout(fn: () => void, ms: number) { this.timers.set(++this.id, { at: this.time + ms, fn }); return this.id; }
	clearTimeout(h: number) { this.timers.delete(h); }
	requestFrame(fn: () => void) { this.frames.set(++this.id, fn); return this.id; }
	cancelFrame(h: number) { this.frames.delete(h); }
	advance(ms: number) {
		this.time += ms;
		for (const [h, t] of [...this.timers]) if (t.at <= this.time) { this.timers.delete(h); t.fn(); }
		const frames = [...this.frames.values()];
		this.frames.clear();
		for (const f of frames) f();
	}
}

describe("LineBreaker", () => {
	const start: Viewport = { scale: 2, offsetX: -560, offsetY: 16 };
	const target: Viewport = { scale: 2, offsetX: 24, offsetY: 16 };
	function setup(over: { enabled?: boolean; busy?: boolean } = {}) {
		const clock = new FakeClock();
		const s = { clock, vp: start, enabled: over.enabled ?? true, busy: over.busy ?? false, b: null as unknown as LineBreaker };
		s.b = new LineBreaker({ enabled: () => s.enabled, busy: () => s.busy, viewport: () => s.vp, setViewport: (v) => (s.vp = v) }, clock);
		return s;
	}

	it("waits, then eases to the target and stops there", () => {
		const s = setup();
		expect(s.b.strokeEnded(target)).toBe(true);
		s.clock.advance(LINE_BREAK_DELAY_MS - 1);
		expect(s.vp).toEqual(start); // never before the pause
		s.clock.advance(1);
		s.clock.advance(100);
		expect(s.vp.offsetX).toBeGreaterThan(start.offsetX);
		expect(s.vp.offsetX).toBeLessThan(target.offsetX);
		s.clock.advance(1000);
		expect(s.vp).toEqual(target);
		expect(s.b.pending).toBe(false);
	});

	it("does nothing when disabled, without a target, or while a contact is down", () => {
		expect(setup({ enabled: false }).b.strokeEnded(target)).toBe(false);
		expect(setup().b.strokeEnded(null)).toBe(false);
		const s = setup();
		s.b.strokeEnded(target);
		s.busy = true;
		s.clock.advance(5000);
		expect(s.vp).toEqual(start);
	});

	it("is cancelled by a touch and stops if a contact lands mid-animation", () => {
		const s = setup();
		s.b.strokeEnded(target);
		s.b.cancel();
		s.clock.advance(5000);
		expect(s.vp).toEqual(start);
		s.b.strokeEnded(target);
		s.clock.advance(LINE_BREAK_DELAY_MS);
		s.clock.advance(50);
		const mid = s.vp;
		s.busy = true;
		s.clock.advance(1000);
		expect(s.vp).toEqual(mid);
	});
});

describe("tabs (363)", () => {
	it("finds the neighbouring tab, with or without wrapping", () => {
		expect(neighbourTab(3, 0, 1, false)).toBe(1);
		expect(neighbourTab(3, 2, 1, false)).toBe(-1);
		expect(neighbourTab(3, 2, 1, true)).toBe(0);
		expect(neighbourTab(3, 0, -1, true)).toBe(2);
		expect(neighbourTab(3, 0, -1, false)).toBe(-1);
		expect(neighbourTab(1, 0, 1, true)).toBe(-1);
		expect(neighbourTab(3, -1, 1, true)).toBe(-1);
	});

	it("names tabs by title and adds the folder only when titles collide", () => {
		const e = (title: string, path: string) => ({ id: path, title, path });
		expect(tabLabels([e("Maths", "Notebooks/Maths.notebook"), e("Physics", "Notebooks/Physics.notebook")])).toEqual(["Maths", "Physics"]);
		expect(tabLabels([e("Notes", "A/Notes.notebook"), e("Notes", "B/Notes.notebook"), e("Other", "Other.notebook")])).toEqual(["Notes (A)", "Notes (B)", "Other"]);
		expect(tabLabels([e("Notes", "Notes.notebook"), e("Notes", "B/Notes.notebook")])).toEqual(["Notes", "Notes (B)"]);
	});

	describe("two-finger swipe", () => {
		const d = TAB_SWIPE_DISTANCE;
		it("fires once towards the next tab when both fingers move left", () => {
			const s = new TabSwipe();
			s.down(1, 300, 20, 0);
			s.down(2, 340, 22, 5);
			expect(s.move(1, 300 - d - 4, 20, 100)).toBe(0); // the other finger has not moved yet
			expect(s.move(2, 340 - d - 4, 22, 110)).toBe(1);
			expect(s.move(2, 100, 22, 150)).toBe(0); // once per gesture
		});
		it("goes to the previous tab for a swipe to the right", () => {
			const s = new TabSwipe();
			s.down(1, 100, 20, 0);
			s.down(2, 140, 20, 0);
			s.move(1, 100 + d + 5, 20, 80);
			expect(s.move(2, 140 + d + 5, 20, 90)).toBe(-1);
		});
		it("ignores one finger, three fingers, a pinch, a slow or a mostly vertical move", () => {
			let s = new TabSwipe();
			s.down(1, 300, 20, 0);
			expect(s.move(1, 100, 20, 50)).toBe(0);
			s = new TabSwipe();
			s.down(1, 300, 20, 0); s.down(2, 340, 20, 0); s.down(3, 380, 20, 0);
			s.move(1, 100, 20, 50); s.move(2, 140, 20, 50);
			expect(s.move(3, 180, 20, 50)).toBe(0);
			s = new TabSwipe();
			s.down(1, 300, 20, 0); s.down(2, 340, 20, 0);
			s.move(1, 250, 20, 50); // fingers go apart
			expect(s.move(2, 400, 20, 60)).toBe(0);
			s = new TabSwipe();
			s.down(1, 300, 20, 0); s.down(2, 340, 20, 0);
			s.move(1, 200, 20, 1500);
			expect(s.move(2, 240, 20, 1600)).toBe(0); // too slow
			s = new TabSwipe();
			s.down(1, 300, 20, 0); s.down(2, 340, 20, 0);
			s.move(1, 230, 120, 50);
			expect(s.move(2, 270, 120, 60)).toBe(0); // more vertical than sideways
		});
		it("starts fresh after the fingers lift", () => {
			const s = new TabSwipe();
			s.down(1, 300, 20, 0); s.down(2, 340, 20, 0);
			s.move(1, 200, 20, 50); s.move(2, 240, 20, 50);
			s.up(1); s.up(2);
			s.down(1, 300, 20, 1000); s.down(2, 340, 20, 1000);
			s.move(1, 200, 20, 1050);
			expect(s.move(2, 240, 20, 1060)).toBe(1);
		});
	});
});

describe("registry and settings", () => {
	it("registers the two tab actions as commands, and both settings are off by default", () => {
		for (const id of ["notebook-next", "notebook-previous"]) {
			const a = actionById(id)!;
			expect(a.scope).toBe("view");
			expect(a.command).toBe(true);
			expect(a.readOnly).toBe(true);
		}
		expect(DEFAULT_SETTINGS.notebookTabs).toBe(false);
		expect(DEFAULT_SETTINGS.autoLineBreak).toBe(false);
		expect(readSettings({ notebookTabs: true, autoLineBreak: true })).toMatchObject({ notebookTabs: true, autoLineBreak: true });
		expect(readSettings({ notebookTabs: "yes", autoLineBreak: 1 })).toMatchObject({ notebookTabs: false, autoLineBreak: false });
	});
});

describe("tab actions are shown only with another notebook open", () => {
	it("hides them with one notebook and shows them with two", () => {
		const a = actionById("notebook-next")!;
		const ctx = { openNotebooks: 1 } as Parameters<NonNullable<typeof a.when>>[0];
		expect(a.when!(ctx)).toBe(false);
		expect(a.when!({ ...ctx, openNotebooks: 2 })).toBe(true);
		expect(a.when!({} as typeof ctx)).toBe(false);
	});
});
