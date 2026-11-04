import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shown = vi.hoisted(() => [] as unknown[]);
vi.mock("obsidian", () => ({
	setIcon: () => undefined,
	getLanguage: () => "en",
	Notice: class {
		constructor(message: unknown) {
			shown.push(message);
		}
		hide(): void {}
		setMessage(): void {}
	},
	Modal: class {},
	Setting: class {},
}));

import { createDocument } from "../src/model/document";
import { AddPage, type Command } from "../src/model/history";
import type { NotebookDocument } from "../src/model/types";
import { LectureModeController, type LectureModeHost } from "../src/view/lecture-mode";
import type { EditContext } from "../src/view/edit-context";
import type { LectureClass } from "../src/timetable/lecture-mode";
import { LECTURE_MEMORY_KEY } from "../src/timetable/lecture-memory";
import { isoDay } from "../src/timetable/schedule";

/** Just enough of Obsidian's DOM helpers for the controller. */
class El {
	handlers = new Map<string, Array<(e: unknown) => void>>();
	children: El[] = [];
	text = "";
	constructor(public tag = "div") {}
	addClass(): void {}
	removeClass(): void {}
	remove(): void {}
	createDiv(o?: { text?: string }): El {
		return this.add("div", o);
	}
	createSpan(o?: { text?: string }): El {
		return this.add("span", o);
	}
	createEl(tag: string, o?: { text?: string }): El {
		return this.add(tag, o);
	}
	addEventListener(type: string, fn: (e: unknown) => void): void {
		this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
	}
	click(): void {
		for (const fn of this.handlers.get("click") ?? []) fn({ preventDefault() {} });
	}
	private add(tag: string, o?: { text?: string }): El {
		const el = new El(tag);
		el.text = o?.text ?? "";
		this.children.push(el);
		return el;
	}
	find(tag: string): El | undefined {
		return this.children.find((c) => c.tag === tag);
	}
}

const NOW = new Date(2026, 9, 26, 10, 0, 0);
const cls: LectureClass = {
	key: `c1@${isoDay(NOW)}`, course: "Analysis 1", start: "09:00", end: "11:00",
	startsAt: new Date(2026, 9, 26, 9, 0).getTime(), endsAt: new Date(2026, 9, 26, 11, 0).getTime(),
};

interface Rig {
	ctl: LectureModeController;
	doc: NotebookDocument;
	executed: Array<{ cmd: Command; scroll: number | undefined }>;
	store: Map<string, unknown>;
	state: { editable: boolean; cls: LectureClass | null; setting: "off" | "ask" | "auto" };
	went: Array<[string, Date]>;
}

function rig(shared?: { store: Map<string, unknown>; doc: NotebookDocument }): Rig {
	const doc = shared?.doc ?? createDocument(NOW, { width: 595, height: 842 });
	const store = shared?.store ?? new Map<string, unknown>();
	const executed: Rig["executed"] = [];
	const went: Rig["went"] = [];
	const state: Rig["state"] = { editable: true, cls, setting: "auto" };
	const body = new El();
	const ctx = (): EditContext => ({
		doc, execute: (cmd: Command, scroll?: number) => {
			executed.push({ cmd, scroll });
			(cmd as AddPage).apply(doc);
		},
	}) as unknown as EditContext;
	const host: LectureModeHost = {
		parent: () => body as unknown as HTMLElement,
		path: () => "Notebooks/Analysis 1.notebook",
		setting: () => state.setting,
		classFor: () => state.cls,
		busy: () => false,
		editContext: () => (state.editable ? ctx() : null),
		editable: () => state.editable,
		goToLecturePage: (course, date) => went.push([course, date]),
		changed: () => undefined,
		now: () => NOW,
		memory: { load: () => store.get(LECTURE_MEMORY_KEY) ?? null, save: (v) => store.set(LECTURE_MEMORY_KEY, JSON.parse(JSON.stringify(v))) },
	};
	return { ctl: new LectureModeController(host), doc, executed, store, state, went };
}

beforeEach(() => {
	shown.length = 0;
	vi.stubGlobal("window", { setInterval: () => 1, clearInterval: () => undefined, setTimeout, clearTimeout });
	vi.stubGlobal("document", { addEventListener: () => undefined, removeEventListener: () => undefined, visibilityState: "visible" });
	vi.stubGlobal("createFragment", (cb: (f: El) => void) => {
		const f = new El("fragment");
		cb(f);
		return f;
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("lecture mode never adds a page by itself", () => {
	it("entering in automatic mode, the timer and a resume leave the notebook alone", () => {
		const r = rig();
		r.ctl.opened();
		expect(r.ctl.on).toBe(true);
		for (let i = 0; i < 5; i++) r.ctl.evaluate();
		expect(r.executed).toHaveLength(0);
		expect(r.doc.pages).toHaveLength(1);
	});

	it("the first stroke adds the page without moving the view, offers Go, and only once", () => {
		const r = rig();
		r.ctl.opened();
		r.ctl.wrote();
		expect(r.doc.pages).toHaveLength(2);
		expect(r.executed).toHaveLength(1);
		expect(r.executed[0]!.scroll).toBeUndefined();
		r.ctl.wrote();
		r.ctl.evaluate();
		expect(r.executed).toHaveLength(1);
		const notice = shown.find((m) => m instanceof El) as El;
		expect(notice.children[0]!.text).toBe("Lecture page added");
		const go = notice.find("button")!;
		expect(go.text).toBe("Go");
		go.click();
		expect(r.went).toEqual([["Analysis 1", NOW]]);
	});

	it("a deleted page is not added again after the notebook is reopened", () => {
		const r = rig();
		r.ctl.opened();
		r.ctl.wrote();
		r.doc.pages.pop();
		r.ctl.closed();
		const again = rig({ store: r.store, doc: r.doc });
		again.ctl.opened();
		again.ctl.wrote();
		expect(again.executed).toHaveLength(0);
		expect(r.doc.pages).toHaveLength(1);
	});
});

describe("read-only notebooks", () => {
	it("Start and the command refuse to add the page, say so, and change nothing", () => {
		const r = rig();
		r.state.setting = "ask";
		r.state.editable = false;
		r.ctl.opened();
		expect(r.ctl.asked).toBe(true);
		r.ctl.toggle();
		expect(r.ctl.on).toBe(true);
		expect(r.executed).toHaveLength(0);
		expect(r.doc.pages).toHaveLength(1);
		expect(shown).toContain("This notebook is read-only: the lecture page was not added.");
		// Nothing was recorded as paged, so the page is still added once the notebook is writable and the user acts.
		r.state.editable = true;
		r.ctl.wrote();
		expect(r.executed).toHaveLength(1);
	});

	it("a stroke in a read-only view adds nothing either", () => {
		const r = rig();
		r.ctl.opened();
		r.state.editable = false;
		r.ctl.wrote();
		expect(r.executed).toHaveLength(0);
	});
});

describe("Not now is remembered", () => {
	it("across reopening the notebook, with corrupt storage reading as nothing remembered", () => {
		const r = rig();
		r.state.setting = "ask";
		r.ctl.opened();
		const banner = (r.ctl as unknown as { banner: El }).banner;
		banner.children[2]!.children[1]!.click();
		r.ctl.closed();
		const again = rig({ store: r.store, doc: r.doc });
		again.state.setting = "ask";
		again.ctl.opened();
		expect(again.ctl.asked).toBe(false);
		const broken = rig({ store: new Map([[LECTURE_MEMORY_KEY, "garbage"]]), doc: r.doc });
		broken.state.setting = "ask";
		broken.ctl.opened();
		expect(broken.ctl.asked).toBe(true);
	});
});
