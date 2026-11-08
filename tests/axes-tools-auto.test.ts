import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	setIcon: () => undefined,
	getLanguage: () => "en",
	Notice: class {
		hide(): void {}
		setMessage(): void {}
	},
	Modal: class {},
	Setting: class {},
}));

import { writing } from "../src/ink/writing-guard";
import { createDocument, createStroke } from "../src/model/document";
import { History, type Command } from "../src/model/history";
import { checkContent } from "../src/model/serialize";
import type { Point } from "../src/model/types";
import { DEFAULT_SETTINGS } from "../src/settings";
import { AxesTools, type AxesHost } from "../src/view/axes-tools";

/** A clean "L": down 100, then right 120. */
function ell(): Point[] {
	const out: Point[] = [];
	for (let y = 40; y <= 140; y += 5) out.push([100, y, 0.5]);
	for (let x = 105; x <= 220; x += 5) out.push([x, 140, 0.5]);
	return out;
}

// Review fix (D7): in "automatic" the 450 ms wait is dropped by the next contact, and never converts under the pen.
describe("axes tools: automatic conversion timer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("window", { setTimeout, clearTimeout, navigator: {} });
	});
	afterEach(() => {
		writing.reset();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	function scene() {
		const doc = createDocument(new Date(2026, 9, 26), { width: 595, height: 842 });
		const history = new History(() => doc, 500, checkContent);
		const executed: string[] = [];
		const host: AxesHost = {
			stage: () => ({}) as HTMLElement,
			doc: () => doc,
			editable: () => true,
			execute: (cmd: Command) => {
				executed.push(cmd.label);
				return history.execute(cmd);
			},
			settings: () => ({ ...DEFAULT_SETTINGS, axesDraw: "auto" }),
			toStage: () => [0, 0],
			insertTarget: () => null,
			penColor: () => "#000000",
			penWidth: () => 2,
			select: () => undefined,
			refresh: () => undefined,
		};
		const tools = new AxesTools(host);
		const draw = (points: Point[]) => {
			const s = createStroke("#112233", 2, points);
			doc.pages[0]!.strokes.push(s);
			tools.strokesAdded(0, doc.pages[0]!.strokes);
			return s;
		};
		return { doc, tools, executed, draw };
	}

	it("converts an L after the wait when nothing else happens", () => {
		const { tools, executed, draw } = scene();
		draw(ell());
		vi.advanceTimersByTime(449);
		expect(executed).toHaveLength(0);
		vi.advanceTimersByTime(5);
		expect(executed).toEqual(["Make axes"]);
		tools.destroy();
	});

	it("the next stroke (still writing) keeps the L as ink", () => {
		const { doc, executed, draw } = scene();
		draw(ell());
		vi.advanceTimersByTime(200);
		draw([[300, 300, 0.5], [320, 302, 0.5], [340, 301, 0.5]]);
		vi.advanceTimersByTime(2000);
		expect(executed).toHaveLength(0);
		expect(doc.pages[0]!.strokes).toHaveLength(2);
	});

	it("a new contact before the wait ends drops the conversion", () => {
		const { tools, executed, draw } = scene();
		draw(ell());
		vi.advanceTimersByTime(300);
		tools.strokeStarted();
		vi.advanceTimersByTime(2000);
		expect(executed).toHaveLength(0);
	});

	it("a scroll by the person or leaving the page drops it; the follow-the-pen movement does not", () => {
		const a = scene();
		a.draw(ell());
		a.tools.viewChanged(false);
		vi.advanceTimersByTime(500);
		expect(a.executed).toHaveLength(1);
		const b = scene();
		b.draw(ell());
		b.tools.viewChanged(true);
		vi.advanceTimersByTime(500);
		expect(b.executed).toHaveLength(0);
		const c = scene();
		c.draw(ell());
		c.tools.cancelOffer();
		vi.advanceTimersByTime(500);
		expect(c.executed).toHaveLength(0);
	});

	it("never converts while the pen is on the screen", () => {
		const { executed, draw } = scene();
		draw(ell());
		writing.penDown(7);
		vi.advanceTimersByTime(600);
		expect(executed).toHaveLength(0);
	});
});
