import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

import { attachedInk, inkOnRemoved, inkOwner, ownsInk } from "../src/ink/attach";
import { detectScribble, scribbleEraseCommand, scribbleEraseSteps, scribbleVictims } from "../src/ink/scribble";
import { createDocument, createStroke, quantizePoint } from "../src/model/document";
import { History } from "../src/model/history";
import { createBox, createMarker } from "../src/model/markers";
import { parse, serialize } from "../src/model/serialize";
import type { NotebookDocument, Page, Point, Stroke } from "../src/model/types";

const { gestureWorld, runGesture } = await import("../src/view/pen-gesture-actions");
const { encodeMarkdownPath, isConflictedCopyPath, maskCode, planNoteLinks, applyLinkChanges, scanPageLinks } = await import("../src/integration/link-update");
type Lookup = import("../src/integration/link-update").NotebookLookup;

// --- shared helpers ---

function stroke(points: Array<[number, number]>, width = 2): Stroke {
	return createStroke("#1e1e1e", width, points.map(([x, y]) => quantizePoint(x, y, 0.5)));
}

function hidden(s: Stroke): Stroke {
	return { ...s, hidden: true };
}

/** A handwritten word: tall strokes side by side. */
function word(x0: number, y0: number, n = 6): Stroke[] {
	return Array.from({ length: n }, (_, i) => stroke([[x0 + i * 14, y0 - 10], [x0 + i * 14 + 1, y0], [x0 + i * 14, y0 + 10]]));
}

/** A fast zig-zag scratch sampled every ~1 pt. */
function zigzag(cx = 190, cy = 100, half = 50, legs = 7, pitch = 4): Point[] {
	const vertices: Array<[number, number]> = [];
	for (let i = 0; i <= legs; i++) vertices.push([cx + (i % 2 === 0 ? -half : half), cy + (i - legs / 2) * pitch]);
	const out: Point[] = [];
	for (let i = 1; i < vertices.length; i++) {
		const [ax, ay] = vertices[i - 1]!, [bx, by] = vertices[i]!;
		const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
		for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, 0.5]);
	}
	return out;
}

function docWith(strokes: Stroke[]): { doc: NotebookDocument; page: Page } {
	const doc = createDocument(new Date("2026-10-30T10:00:00.000Z"));
	const page = doc.pages[0]!;
	page.strokes.push(...strokes);
	return { doc, page };
}

// --- 1. scribble erase and pen gestures leave hidden ink alone ---

describe("scribble erase and hidden ink (invisible solutions)", () => {
	it("scratching visible writing does not delete the hidden ink under it", () => {
		const visible = word(150, 100);
		const solution = word(150, 102).map(hidden);
		const { doc, page } = docWith([...visible, ...solution]);
		const cmd = scribbleEraseCommand(page, zigzag(), 500, 2);
		expect(cmd).not.toBeNull();
		new History(() => doc).execute(cmd!);
		expect(page.strokes).toEqual(solution);
	});

	it("deletes hidden ink only while the solutions of the page are shown", () => {
		const solution = word(150, 100).map(hidden);
		const scribble = detectScribble(zigzag(), 500)!;
		expect(scribbleVictims(scribble, solution, 2)).toEqual([]);
		expect(scribbleVictims(scribble, solution, 2, undefined, true)).toEqual(solution);
	});

	it("two-step erase keeps indices against all the strokes of the page", () => {
		const a = hidden(stroke([[10, 10], [20, 20]]));
		const visible = word(150, 100);
		const b = hidden(stroke([[400, 400], [420, 420]]));
		const { doc, page } = docWith([a, ...visible.slice(0, 3), hidden(visible[3]!), ...visible.slice(4), b]);
		const before = [...page.strokes];
		const scratch = stroke(zigzag().map((p) => [p[0], p[1]] as [number, number]));
		const steps = scribbleEraseSteps(page, scratch, 500)!;
		expect(steps).not.toBeNull();
		const history = new History(() => doc);
		history.execute(steps.keep);
		history.execute(steps.erase);
		expect(page.strokes).toEqual([a, before[4], b]);
		history.undo();
		history.undo();
		expect(page.strokes).toEqual(before);
	});

	it("a scribble over hidden ink only is not a scribble erase", () => {
		const { page } = docWith(word(150, 100).map(hidden));
		const scratch = stroke(zigzag().map((p) => [p[0], p[1]] as [number, number]));
		expect(scribbleEraseSteps(page, scratch, 500)).toBeNull();
		expect(scribbleEraseSteps(page, scratch, 500, undefined, {}, true)).not.toBeNull();
	});
});

/** A gesture view on one page at scale 1 (stage px = page pt). */
function gestureView(doc: NotebookDocument, revealed: boolean, executed: unknown[][]) {
	return {
		app: {} as never,
		settings: () => ({ penGestureSpacePt: 40 }) as never,
		doc: () => doc,
		editable: () => true,
		pageIndexAt: () => 0,
		toLocal: (_i: number, p: { x: number; y: number }) => [p.x, p.y] as [number, number],
		stageRect: () => ({ left: 0, top: 0 }) as DOMRect,
		boundsOf: () => undefined,
		revealed: () => revealed,
		selection: () => null,
		selectionHit: () => false,
		selectPolygon: () => undefined,
		clearSelection: () => undefined,
		penStyle: () => ({ color: "#1e1e1e", width: 2 }),
		execute: (commands: unknown[]) => void executed.push(commands),
		editTags: () => undefined,
		openSearch: () => undefined,
	};
}

describe("pen gestures and hidden ink", () => {
	const trail = zigzag().map((p, i) => ({ x: p[0], y: p[1], t: i * 2, p: 0.5 }));
	const loop = Array.from({ length: 40 }, (_, i) => {
		const a = (i / 39) * Math.PI * 2;
		return { x: 190 + Math.cos(a) * 80, y: 100 + Math.sin(a) * 30, t: i * 5, p: 0.5 };
	});

	it("the delete gesture neither counts nor removes hidden ink", () => {
		const visible = word(150, 100);
		const solution = word(150, 102).map(hidden);
		const { doc, page } = docWith([...visible, ...solution]);
		const executed: unknown[][] = [];
		const v = gestureView(doc, false, executed);
		expect(gestureWorld(v).scribbleVictims(trail)).toBe(visible.length);
		runGesture(v, { type: "builtin", id: "delete" } as never, trail);
		expect(executed).toHaveLength(1);
		const history = new History(() => doc);
		for (const c of executed[0]!) history.execute(c as never);
		expect(page.strokes).toEqual(solution);
	});

	it("hidden ink alone is no target of the delete or the circle-select gesture", () => {
		const { doc } = docWith(word(150, 100).map(hidden));
		const shut = gestureView(doc, false, []);
		expect(gestureWorld(shut).scribbleVictims(trail)).toBe(0);
		expect(gestureWorld(shut).enclosedInk(loop)).toBe(0);
		const open = gestureView(doc, true, []);
		expect(gestureWorld(open).scribbleVictims(trail)).toBe(6);
		expect(gestureWorld(open).enclosedInk(loop)).toBe(6);
	});
});

// --- 7. markers and boxes do not own ink; hidden ink is not offered ---

describe("ink ownership: markers and boxes frame the page, they hold no ink", () => {
	it("a box or a region marker never owns the ink inside it", () => {
		const box = createBox("definition", { x: 100, y: 100, width: 200, height: 100 });
		const marker = createMarker("gap", 0, 0, { region: { x: 100, y: 100, width: 200, height: 100 } });
		const inside = stroke([[120, 120], [200, 150], [280, 180]]);
		expect(ownsInk(box)).toBe(false);
		expect(ownsInk(marker)).toBe(false);
		expect(inkOwner(inside, [box])).toBeNull();
		expect(inkOwner(inside, [marker])).toBeNull();
		expect(attachedInk([inside], [box, marker], [box, marker])).toEqual([]);
		expect(inkOnRemoved([inside, hidden(inside)], [box], [box])).toEqual([]);
	});

	it("ink on an image framed by a box still belongs to the image", () => {
		const img = { id: "img1", type: "image" as const, asset: "ab", x: 100, y: 100, width: 200, height: 100, rotation: 0 };
		const box = createBox("example", { x: 90, y: 90, width: 220, height: 120 });
		const s = stroke([[120, 120], [200, 150], [280, 180]]);
		expect(inkOwner(s, [img, box])).toBe(img);
		expect(attachedInk([s], [img, box], [img])).toEqual([s]);
	});
});

// --- 11. normalised marker labels count as dropped ---

describe("marker labels that reading normalises", () => {
	function withLabel(text: unknown): string {
		const doc = createDocument(new Date("2026-10-30T10:00:00.000Z"));
		doc.pages[0]!.elements = [createMarker("question", 10, 10, { text: "placeholder" })];
		const raw = JSON.parse(serialize(doc)) as { pages: Array<{ elements: Array<Record<string, unknown>> }> };
		raw.pages[0]!.elements[0]!.text = text;
		return JSON.stringify(raw);
	}

	it("a label with extra spaces is kept normalised and counted as dropped", () => {
		const r = parse(withLabel("  why   is\nthis so?  "));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect((r.doc.pages[0]!.elements![0] as { text?: string }).text).toBe("why is this so?");
		expect(r.dropped).toBe(1);
	});

	it("a blank or too long label is counted; a clean one is not", () => {
		const blank = parse(withLabel("   "));
		expect(blank.ok && blank.dropped).toBe(1);
		const long = parse(withLabel("x".repeat(400)));
		expect(long.ok && long.dropped).toBe(1);
		const clean = parse(withLabel("why is this so?"));
		expect(clean.ok && clean.dropped).toBeUndefined();
	});
});

// --- 12. error notices skip the writing-quiet queue ---

describe("error notices while the pen is down", () => {
	it("an ordinary notice waits, an error notice is shown at once", async () => {
		const { writing } = await import("../src/ink/writing-guard");
		const { showErrorNotice, showNotice } = await import("../src/view/notice");
		const { Notice } = (await import("obsidian")) as unknown as { Notice: { shown: string[] } };
		Notice.shown.length = 0;
		vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => undefined });
		writing.penDown(7);
		try {
			showNotice("tool changed");
			showErrorNotice("Notebook: save failed");
			expect(Notice.shown).toEqual(["Notebook: save failed"]);
		} finally {
			writing.reset();
			vi.unstubAllGlobals();
		}
	});
});

// --- 6 and 8. "Update links": encoding, conflicted copies, what is masked, the line shown ---

describe("update links: relocation targets and masking", () => {
	const note = "n/Note.md";
	function lookupOf(books: Record<string, string[]>, moved: Record<string, string[]> = {}): Lookup {
		const byName = new Map(Object.keys(books).map((p) => [p.split("/").pop()!.toLowerCase(), p] as const));
		return {
			resolve: (lp) => {
				const path = byName.get((lp.split("/").pop() ?? "").toLowerCase());
				return path ? { path, ambiguous: false } : null;
			},
			pageIds: async (p) => books[p] ?? null,
			notebooksWithPage: async (id) => Object.entries(books).filter(([, ids]) => ids.includes(id)).map(([p]) => p),
			linkPathFor: (p) => p.split("/").pop()!,
			isConflictedCopy: (p) => isConflictedCopyPath(p, Object.keys(books)),
			movedPageIds: async (id) => moved[id] ?? [],
		};
	}

	it("encodes parentheses, # and ? in a Markdown link target", () => {
		expect(encodeMarkdownPath("Physics (1).notebook")).toBe("Physics%20%281%29.notebook");
		expect(encodeMarkdownPath("C# notes?.notebook")).toBe("C%23%20notes%3F.notebook");
		expect(decodeURIComponent(encodeMarkdownPath("A (b) #c.notebook"))).toBe("A (b) #c.notebook");
	});

	it("relocates a Markdown link to a notebook with parentheses so that it still parses", async () => {
		const books = { "N/Old.notebook": ["a"], "N/Physics (2026).notebook": ["z", "b"] };
		const text = "[x](Old.notebook#p1&id=b)";
		const plan = await planNoteLinks(note, text, lookupOf(books));
		const out = applyLinkChanges(text, plan.changes).text;
		expect(out).toBe("[x](Physics%20%282026%29.notebook#p2&id=b)");
		expect(scanPageLinks(out).map((l) => [l.path, l.fragment])).toEqual([["Physics (2026).notebook", "p2&id=b"]]);
	});

	it("keeps the path exactly as written in `before`, however it was encoded", async () => {
		const books = { "N/My Old.notebook": ["a"], "N/New.notebook": ["b"] };
		const text = "[x](My%20Old.notebook#p1&id=b)";
		const plan = await planNoteLinks(note, text, lookupOf(books));
		expect(plan.changes[0]!.before).toBe("My%20Old.notebook#p1&id=b");
		expect(applyLinkChanges(text, plan.changes)).toMatchObject({ text: "[x](New.notebook#p1&id=b)", applied: 1, stale: 0 });
	});

	it("never relocates to a conflicted copy, which holds the same page ids", async () => {
		const books = { "N/Old.notebook": ["a"], "N/New.notebook": ["b"], "N/New (1).notebook": ["b"], "N/Gone (1).notebook": ["q"], "N/Gone.notebook": [] };
		const plan = await planNoteLinks(note, "[[Old.notebook#p1&id=b]] [[Old.notebook#p1&id=q]]", lookupOf(books));
		expect(plan.changes.map((c) => c.notebook)).toEqual(["N/New.notebook"]);
		expect(plan.skipped.map((s) => s.reason)).toEqual(["page-gone"]);
		expect(isConflictedCopyPath("N/New (1).notebook", Object.keys(books))).toBe(true);
		expect(isConflictedCopyPath("N/New.notebook", Object.keys(books))).toBe(false);
		// "(1)" alone, without the base notebook in the same folder, is a name like any other.
		expect(isConflictedCopyPath("M/New (1).notebook", ["M/New (1).notebook", "N/New.notebook"])).toBe(false);
	});

	it("follows a page that a move gave a new id", async () => {
		const books = { "N/Old.notebook": ["a"], "N/New.notebook": ["z", "b2"] };
		const plan = await planNoteLinks(note, "[[Old.notebook#p1&id=b]]", lookupOf(books, { b: ["b2"] }));
		expect(plan.changes[0]).toMatchObject({ kind: "relocate", notebook: "N/New.notebook", after: "New.notebook#p2&id=b2" });
	});

	it("masks fences in blockquotes, callouts and lists, comments and the frontmatter", () => {
		const text = [
			"---",
			"source: \"[[Physics.notebook#p1]]\"",
			"---",
			"> [!note]",
			"> ```",
			"> [[Physics.notebook#p2]]",
			"> ```",
			"- item",
			"    ~~~~",
			"    [[Physics.notebook#p3]]",
			"    ~~~",
			"    still code [[Physics.notebook#p4]]",
			"    ~~~~",
			"%% hidden [[Physics.notebook#p5]]",
			"still hidden %% [[Physics.notebook#p6]]",
		].join("\n");
		const masked = maskCode(text);
		expect(masked).toHaveLength(text.length);
		expect(masked.split("\n")).toHaveLength(text.split("\n").length);
		expect(scanPageLinks(text).map((l) => l.fragment)).toEqual(["p6"]);
	});

	it("tells each link apart in the list by the text of its line", async () => {
		const books = { "N/Physics.notebook": ["a", "b"] };
		const text = "intro\n  - see [[Physics.notebook#p2]] for the proof  \n[[Physics.notebook#p9]]";
		const plan = await planNoteLinks(note, text, lookupOf(books));
		expect(plan.changes[0]).toMatchObject({ line: 2, lineText: "- see [[Physics.notebook#p2]] for the proof" });
		expect(plan.skipped[0]).toMatchObject({ line: 3, lineText: "[[Physics.notebook#p9]]" });
	});
});

// --- 3. moved pages keep their ids; a clash is recorded for "Update links" ---

describe("move to notebook: page ids", () => {
	it("keeps the ids the target does not have and renames only a clash", async () => {
		const { planPageMove } = await import("../src/library/page-move");
		const src = createDocument(new Date("2026-10-30T10:00:00.000Z"));
		src.pages.push({ ...src.pages[0]!, id: "p-two", strokes: [] });
		const target = createDocument(new Date("2026-10-30T10:00:00.000Z"));
		target.pages[0] = { ...target.pages[0]!, id: "p-two" };
		const plan = planPageMove(src, [src.pages[0]!.id, "p-two"], target);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.pages[0]!.id).toBe(src.pages[0]!.id);
		expect(plan.pages[1]!.id).not.toBe("p-two");
		expect(plan.renamed).toEqual([{ from: "p-two", to: plan.pages[1]!.id }]);
		expect(new Set([...target.pages, ...plan.pages].map((p) => p.id)).size).toBe(3);
	});

	it("records renamed ids per device and merges every device's file on read", async () => {
		const { FakeVault } = await import("./fake-vault");
		const { PageMoveStore, PageMovesBlockedError } = await import("../src/storage/page-moves");
		const vault = new FakeVault({ "Notebooks/_meta/page-moves-bbbbbbbb.json": `{"format":"obsidian-notebook-page-moves","version":1,"moves":[\n{"from":"x","to":"x3","doc":"d","at":"2026-10-30T12:00:00.000Z"}\n]}\n` });
		const adapter = {
			exists: async (p: string) => vault.files.has(p) || vault.folders.has(p),
			read: async (p: string) => vault.files.get(p) ?? "",
			write: async (p: string, d: string) => void vault.put(p, d),
			mkdir: async (p: string) => void vault.folders.add(p),
			list: async (f: string) => [...vault.files.keys()].filter((p) => p.startsWith(`${f}/`) && !p.slice(f.length + 1).includes("/")),
		};
		const store = new PageMoveStore(adapter, () => "Notebooks", "aaaaaaaa");
		await store.record([{ from: "x", to: "x2", doc: "d", at: "2026-10-30T11:00:00.000Z" }]);
		expect(vault.files.has("Notebooks/_meta/page-moves-aaaaaaaa.json")).toBe(true);
		expect((await store.load()).get("x")).toEqual(["x2", "x3"]);
		// An empty own file (not synced yet) is never written over: refused, and kept as a copy.
		vault.put(store.ownPath, "");
		await expect(store.record([{ from: "y", to: "y2", doc: "d", at: "2026-10-30T13:00:00.000Z" }])).rejects.toBeInstanceOf(PageMovesBlockedError);
		expect(vault.files.get(store.ownPath)).toBe("");
		expect([...vault.files.keys()].some((p) => p.includes("page-moves.unreadable-"))).toBe(true);
	});
});

// --- 9. multi-delete deletes only the version that was kept ---

describe("deleting several pages: the copy must be the version deleted", () => {
	it("a page edited or replaced after its copy needs a new copy", async () => {
		const { stashSnapshot, unstashedPages } = await import("../src/model/page-ops");
		const doc = createDocument(new Date("2026-10-30T10:00:00.000Z"));
		doc.pages.push({ ...doc.pages[0]!, id: "b", strokes: [] }, { ...doc.pages[0]!, id: "c", strokes: [] });
		const ids = ["b", "c"];
		const stashed = new Map<string, { page: Page; snapshot: string }>();
		expect(unstashedPages(doc, ids, stashed).map((p) => p.id)).toEqual(["b", "c"]);
		for (const p of doc.pages.slice(1)) stashed.set(p.id, { page: p, snapshot: stashSnapshot(p) });
		expect(unstashedPages(doc, ids, stashed)).toEqual([]);
		// Written on after its copy was made.
		doc.pages[1]!.strokes.push(stroke([[1, 1], [2, 2]]));
		// Replaced by another object with the same id (a version restore).
		doc.pages[2] = { ...doc.pages[2]! };
		expect(unstashedPages(doc, ids, stashed).map((p) => p.id)).toEqual(["b", "c"]);
	});
});

// --- 10. practice copies leave the open items of the original out ---

describe("practice copies and markers", () => {
	it("gap, question and homework markers stay with the original; importance markers and boxes are copied", async () => {
		const { buildPracticePage } = await import("../src/model/practice");
		const { page } = docWith([stroke([[10, 10], [20, 20]])]);
		page.elements = [
			createMarker("homework", 10, 10, { text: "exercise 3" }), createMarker("gap", 30, 30), createMarker("question", 50, 50, { text: "why?" }),
			createMarker("important", 70, 70), createBox("example", { x: 0, y: 0, width: 100, height: 100 }),
		];
		const copy = buildPracticePage(page, {}, 1);
		expect(copy.markers).toBe(3);
		expect(copy.page.elements!.map((e) => (e.type === "marker" ? e.kind : e.type))).toEqual(["important", "box"]);
		expect(copy.page.elements!.every((e) => !page.elements!.some((o) => o.id === e.id))).toBe(true);
		expect(page.elements).toHaveLength(5);
		const bare = docWith([]).page;
		bare.elements = [createMarker("gap", 1, 1)];
		expect(buildPracticePage(bare, {}, 2).page.elements).toBeUndefined();
	});
});

// --- 2. homework ticked in the companion note is read back, never undone ---

const cc = await import("../src/model/companion-content");
const { SetMarkerDone } = await import("../src/model/marker-commands");

describe("companion note: homework ticks made in the note", () => {
	const ctx = { notebookPath: "Analysis.notebook", pageUri: (n: number) => `obsidian://x?page=${n}` };
	// A tiny frontmatter of `key: <JSON>` lines, enough for these tests.
	const deps = {
		frontmatterInfo: (text: string) => {
			const end = text.startsWith("---\n") ? text.indexOf("\n---", 3) : -1;
			return end < 0 ? { exists: false, from: 0, to: 0 } : { exists: true, from: 4, to: end + 1 };
		},
		parseFrontmatter: (yaml: string) =>
			Object.fromEntries(yaml.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")), JSON.parse(l.slice(l.indexOf(":") + 1)) as unknown])),
		stringify: (d: Record<string, unknown>) => Object.entries(d).map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`).join(""),
	};
	function hwDoc() {
		const { doc, page } = docWith([]);
		page.id = "p1";
		page.elements = [
			{ ...createMarker("homework", 10, 10, { text: "Exercises 3.1" }), id: "hw1", due: "2026-11-05" },
			{ ...createMarker("homework", 10, 50, { text: "Read chapter 4" }), id: "hw2" },
		];
		return doc;
	}
	/** One companion update, as the service does it: ticks read from the note, the region regenerated. */
	function regenerate(doc: NotebookDocument, note: string): string {
		const content = cc.companionContent(doc, ctx, cc.homeworkFromNote(doc, note));
		const r = cc.updateCompanionText(note, content, (owned) => cc.renderRegion(content, owned), deps);
		return r.kind === "changed" ? r.text : note;
	}

	it("ties each task line to its marker with a block id", () => {
		const doc = hwDoc();
		const note = regenerate(doc, "My notes\n");
		expect(note).toContain("- [ ] Exercises 3.1 📅 2026-11-05 ^nb-hw1");
		expect(note).toContain("- [ ] Read chapter 4 ^nb-hw2");
		expect(note).toContain("My notes\n");
		expect(regenerate(doc, note)).toBe(note);
	});

	it("a tick made in the note (with the Tasks plugin's done date) is kept and reported for the notebook", () => {
		const doc = hwDoc();
		const ticked = regenerate(doc, "").replace("- [ ] Exercises 3.1 📅 2026-11-05 ^nb-hw1", "- [x] Exercises 3.1 📅 2026-11-05 ✅ 2026-10-31 ^nb-hw1");
		expect(cc.userTicks(doc, cc.readHomeworkTasks(ticked), cc.readRegionState(ticked))).toEqual([{ pageId: "p1", markerId: "hw1", anchor: "nb-hw1" }]);
		// The notebook is not open here: the tick and its done date stay, again and again.
		const kept = regenerate(doc, ticked);
		expect(kept).toBe(ticked);
		// Once the notebook has it done (one undo step), the line stays as it is and the plugin now owns the tick.
		const history = new History(() => doc);
		history.execute(new SetMarkerDone("p1", "hw1", true));
		const after = regenerate(doc, kept);
		expect(after).toContain("- [x] Exercises 3.1 📅 2026-11-05 ✅ 2026-10-31 ^nb-hw1");
		expect(cc.readRegionState(after)?.done).toEqual(["nb-hw1"]);
		expect(cc.userTicks(doc, cc.readHomeworkTasks(after), cc.readRegionState(after))).toEqual([]);
		// Reopened in the notebook: a tick the plugin wrote follows the notebook.
		history.undo();
		expect(regenerate(doc, after)).toContain("- [ ] Exercises 3.1 📅 2026-11-05 ^nb-hw1");
	});

	it("unticking one's own tick in the note before the notebook saw it is respected", () => {
		const doc = hwDoc();
		const base = regenerate(doc, "");
		const ticked = base.replace("- [ ] Read chapter 4 ^nb-hw2", "- [x] Read chapter 4 ^nb-hw2");
		expect(regenerate(doc, ticked)).toBe(ticked);
		expect(regenerate(doc, ticked.replace("- [x] Read chapter 4", "- [ ] Read chapter 4"))).toBe(base);
	});

	it("only lines of the generated region count", () => {
		const doc = hwDoc();
		const note = `- [x] my own task ^nb-hw2\n\n${regenerate(doc, "")}`;
		expect(cc.userTicks(doc, cc.readHomeworkTasks(note), cc.readRegionState(note))).toEqual([]);
		expect(cc.homeworkAnchor("not an id!")).toBeNull();
	});
});
