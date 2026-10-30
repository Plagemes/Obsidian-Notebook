/**
 * Review fixes of format v7: field-by-field bookmark merge, bounded paper geometry, page time of the
 * workspace layout, page moves keeping bookmarks, lenient read of bad v7 details, categories of existing
 * pages, the library index version.
 */
import { describe, expect, it } from "vitest";
import { patchNotebookMeta } from "../src/library/host-logic";
import { INDEX_VERSION, LibraryIndex } from "../src/library/index";
import { planPageMove, withMovedBookmarks } from "../src/library/page-move";
import { entryFromFile } from "../src/library/scan";
import { pagesToPdf } from "../src/ink/export-pdf";
import { pageToSvg } from "../src/ink/export-svg";
import { paperPattern } from "../src/ink/paper";
import { MAX_PAPER_SEGMENTS } from "../src/ink/paper-kinds";
import { categoriesInUse, setBookmark } from "../src/model/bookmarks";
import { cloneMeta, createDocument, createPage } from "../src/model/document";
import { Batch, History, InsertPages, SetMeta } from "../src/model/history";
import { mergeChangeCount, mergeCovers, planMerge } from "../src/model/merge";
import { repairNotebookText } from "../src/model/repair";
import { MIN_PAPER_SPACING, parse, serialize, serializeChecked } from "../src/model/serialize";
import { DocumentSession, type BackupReason, type DocumentIO, type Timers } from "../src/storage/session";
import { PAGE_AT_KEY, PageClock, pageState, startPosition } from "../src/view/position-sync";
import { A4_HEIGHT, A4_WIDTH, DEFAULT_META, PAPER_KINDS_V7, PAPER_SPACING, type NotebookDocument, type Page, type PaperKind } from "../src/model/types";
import { setAt, type Raw } from "./raw-json";
import { nodeClearTimeout, nodeSetTimeout } from "./node-env";

function parsed(text: string) {
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r;
}

function twoPages(): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	doc.pages[0]!.id = "p1";
	const p2 = createPage();
	p2.id = "p2";
	doc.pages.push(p2);
	doc.meta = cloneMeta(DEFAULT_META);
	return doc;
}

describe("merge of bookmark details, field by field", () => {
	it("fills in the fields the main notebook lacks (main {color} + copy {title})", () => {
		const main = twoPages();
		main.meta = setBookmark(main.meta!, "p1", { color: "#22c55e" });
		const other = twoPages();
		other.meta = setBookmark(other.meta!, "p1", { title: "Chapter 3" });
		expect(mergeCovers(main, other)).toBe(false);
		const plan = planMerge(main, other);
		expect(plan.summary.bookmarkInfoAdded).toBe(1);
		expect(plan.summary.bookmarkInfoDiffer).toBe(0);
		expect(mergeChangeCount(plan.summary)).toBe(1);
		expect(plan.command).not.toBeNull();
		new History(() => main).execute(plan.command!);
		expect(main.meta?.bookmarkInfo?.p1).toEqual({ title: "Chapter 3", color: "#22c55e" });
		const saved = parsed(serialize(main)).doc;
		expect(mergeCovers(saved, other)).toBe(true);
		// Idempotent.
		expect(planMerge(saved, other).command).toBeNull();
	});

	it("keeps the main value of a field set on both sides, counts it, and is not covered", () => {
		const main = twoPages();
		main.meta = setBookmark(main.meta!, "p1", { title: "Main", category: "review" });
		const other = twoPages();
		other.meta = setBookmark(other.meta!, "p1", { title: "Copy", color: "#3b82f6", category: "review" });
		const plan = planMerge(main, other);
		expect(plan.summary.bookmarkInfoAdded).toBe(1);
		expect(plan.summary.bookmarkInfoDiffer).toBe(1);
		new History(() => main).execute(plan.command!);
		expect(main.meta?.bookmarkInfo?.p1).toEqual({ title: "Main", color: "#3b82f6", category: "review" });
		expect(mergeCovers(parsed(serialize(main)).doc, other)).toBe(false);
	});
});

describe("categories in use", () => {
	it("ignores bookmarks left on pages that no longer exist", () => {
		const doc = twoPages();
		let meta = setBookmark(doc.meta!, "p1", { category: "review" });
		meta = setBookmark(meta, "gone", { category: "old course" });
		expect(categoriesInUse(meta)).toEqual(["review", "old course"]);
		expect(categoriesInUse(meta, doc.pages)).toEqual(["review"]);
	});
});


function rawOf(doc: NotebookDocument): Raw {
	return JSON.parse(serialize(doc)) as Raw;
}

describe("lenient read of invalid v7 details", () => {
	function withBadDetails(): Raw {
		const doc = twoPages();
		doc.meta = setBookmark(doc.meta!, "p1", { title: "Keep me", category: "review" });
		doc.position = { page: "p2", y: 40, at: "2026-10-29T11:00:00.000Z" };
		const raw = rawOf(doc);
		setAt(raw, ["meta", "bookmarkInfo", "p1", "color"], "red");
		// A detail entry of a page that is not bookmarked (an orphan) with a bad colour.
		setAt(raw, ["meta", "bookmarkInfo", "orphan"], { color: 12 });
		setAt(raw, ["position", "y"], "forty");
		return raw;
	}

	it("drops only the invalid fields and counts them; the notebook opens", () => {
		const r = parse(JSON.stringify(withBadDetails()));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.dropped).toBe(3);
		expect(r.doc.meta?.bookmarkInfo).toEqual({ p1: { title: "Keep me", category: "review" } });
		expect(r.doc.position).toEqual({ page: "p2", at: "2026-10-29T11:00:00.000Z" });
		// What is written is valid as a whole and reads back with nothing dropped.
		const again = parsed(serializeChecked(r.doc).ok ? serialize(r.doc) : "");
		expect(again.dropped).toBeUndefined();
	});

	it("drops a position or a details map that is not an object, and invalid entries", () => {
		const raw = withBadDetails();
		raw.position = "page 2";
		setAt(raw, ["meta", "bookmarkInfo", "p1"], "x");
		const r = parsed(JSON.stringify(raw));
		// The position, the p1 entry and the orphan's colour.
		expect(r.dropped).toBe(3);
		expect(r.doc.position).toBeUndefined();
		expect(r.doc.meta?.bookmarkInfo).toBeUndefined();
		setAt(raw, ["meta", "bookmarkInfo"], [1, 2]);
		const list = parsed(JSON.stringify(raw)).doc;
		expect(list.meta?.bookmarks).toEqual(["p1"]);
		expect(list.meta?.bookmarkInfo).toBeUndefined();
	});

	it("a valid file reports nothing dropped", () => {
		const doc = twoPages();
		doc.meta = setBookmark(doc.meta!, "p1", { color: "#22c55e" });
		expect(parsed(serialize(doc)).dropped).toBeUndefined();
	});

	it("never writes invalid details: what is written reads back with nothing dropped", () => {
		const doc = twoPages();
		doc.meta = setBookmark(doc.meta!, "p1", { title: "T" });
		doc.meta.bookmarkInfo!.p1!.color = "red";
		doc.position = { page: "p1", y: Number.NaN, at: "2026-10-29T11:00:00.000Z" };
		for (const full of [false, true]) {
			const out = serializeChecked(doc, full);
			expect(out.ok).toBe(true);
			if (!out.ok) continue;
			const back = parsed(out.text);
			expect(back.dropped).toBeUndefined();
			expect(back.doc.meta?.bookmarkInfo).toEqual({ p1: { title: "T" } });
			expect(back.doc.position).toEqual({ page: "p1", at: "2026-10-29T11:00:00.000Z" });
		}
	});

	it("a library meta edit of such a file asks for a backup; repair counts the dropped fields", () => {
		const text = JSON.stringify(withBadDetails());
		const patched = patchNotebookMeta(text, { favorite: true });
		expect(patched.ok && patched.migrated).toBe(true);
		const repaired = repairNotebookText(text);
		expect(repaired.ok).toBe(true);
		if (repaired.ok) expect(repaired.summary.fieldsReset).toBe(3);
	});

	it("the session keeps a backup of the original text before it can be rewritten", async () => {
		const text = JSON.stringify(withBadDetails());
		const backups: Array<{ content: string; reason: BackupReason }> = [];
		const io: DocumentIO = {
			read: async () => text,
			process: async () => undefined,
			backup: async (content, reason) => {
				backups.push({ content, reason });
				return "backup.bak";
			},
		};
		const timers: Timers = { set: (fn, ms) => nodeSetTimeout(fn, ms), clear: (h) => nodeClearTimeout(h) };
		const s = new DocumentSession(io, timers);
		await s.load();
		expect(s.mode).toBe("ok");
		expect(backups).toEqual([{ content: text, reason: "dropped-details" }]);
		s.dispose();
	});
});

describe("page time of the workspace layout", () => {
	it("is when the page in view changed, not when the layout is saved", () => {
		const clock = new PageClock();
		const monday = new Date("2026-10-26T09:00:00.000Z");
		const later = new Date("2026-10-28T09:00:00.000Z");
		clock.note("A.notebook", 4, monday);
		// Scrolling on the same page and layout saves days later keep Monday.
		clock.note("A.notebook", 4, later);
		expect(clock.since("A.notebook", 4, later)).toBe(monday);
		const resumed = pageState(5, clock.since("A.notebook", 4, later));
		expect(resumed[PAGE_AT_KEY]).toBe(monday.toISOString());
		// So a position another device stored on Tuesday wins on the next restore.
		const doc = twoPages();
		doc.position = { page: "p2", at: "2026-10-27T09:00:00.000Z" };
		expect(startPosition(doc, 1, resumed[PAGE_AT_KEY] as string)).toEqual({ index: 1, y: 0 });
		// A real page change (or another file) restarts the time.
		clock.note("A.notebook", 5, later);
		expect(clock.since("A.notebook", 5, new Date())).toBe(later);
		const now = new Date();
		expect(clock.since("B.notebook", 5, now)).toBe(now);
		expect(clock.since(null, 5, now)).toBe(now);
	});
});

describe("moving pages keeps their bookmarks", () => {
	it("carries bookmarks and details to the copies' new ids; tags travel with the page", () => {
		const src = twoPages();
		src.pages[1]!.tags = ["exam"];
		src.meta = setBookmark(src.meta!, "p2", { title: "Chapter 3", color: "#3b82f6", category: "review" });
		src.meta = setBookmark(src.meta, "p1", undefined);
		const target = twoPages();
		target.id = "target";
		target.meta = setBookmark(target.meta!, "p1", { title: "Target's own" });
		const plan = planPageMove(src, ["p1", "p2"], target);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const [n1, n2] = plan.pages.map((p) => p.id);
		expect(plan.bookmarks).toEqual([{ pageId: n1 }, { pageId: n2, info: { title: "Chapter 3", color: "#3b82f6", category: "review" } }]);
		expect(plan.pages[1]!.tags).toEqual(["exam"]);
		// Applied as one write (an open target: one undo step).
		const history = new History(() => target);
		history.execute(new Batch("Move pages in", [
			new InsertPages(plan.pages, target.pages.length),
			new SetMeta(target.meta, withMovedBookmarks(target.meta, plan.bookmarks)),
		]));
		const saved = parsed(serialize(target)).doc;
		expect(saved.meta?.bookmarks).toEqual(["p1", n1, n2]);
		expect(saved.meta?.bookmarkInfo).toEqual({ p1: { title: "Target's own" }, [n2!]: { title: "Chapter 3", color: "#3b82f6", category: "review" } });
		expect(saved.pages[3]!.tags).toEqual(["exam"]);
		history.undo();
		expect(target.meta?.bookmarks).toEqual(["p1"]);
		expect(target.pages).toHaveLength(2);
	});

	it("adds nothing to the metadata when no moved page is bookmarked", () => {
		const src = twoPages();
		src.meta = setBookmark(src.meta!, "p1", { title: "stays" });
		const plan = planPageMove(src, ["p2"], twoPages());
		expect(plan.ok && plan.bookmarks).toEqual([]);
	});
});

describe("library index of another plugin version", () => {
	it("a newer index version is ignored and saved back unchanged; an older one is rebuilt", () => {
		const future = { version: INDEX_VERSION + 1, entries: [{ path: "N/a.notebook", somethingNew: true }], extra: 1 };
		const idx = LibraryIndex.fromJSON(JSON.parse(JSON.stringify(future)));
		expect(idx.size).toBe(0);
		expect(idx.keepsNewerVersion).toBe(true);
		idx.upsert(entryFromFile({ path: "N/b.notebook", mtime: 1, size: 1 }, twoPages()));
		expect(idx.size).toBe(1);
		expect(JSON.parse(JSON.stringify(idx.toJSON()))).toEqual(future);
		const old = LibraryIndex.fromJSON({ version: INDEX_VERSION - 1, entries: [] });
		expect(old.keepsNewerVersion).toBe(false);
		expect(old.toJSON()).toEqual({ version: INDEX_VERSION, entries: [] });
	});
});

describe("v7 paper patterns stay bounded", () => {
	const sizes: Array<[string, number, number]> = [
		["A4", A4_WIDTH, A4_HEIGHT],
		["A0", 2384, 3370],
		["infinite A4", A4_WIDTH, A4_WIDTH * 20],
		["absurd", 595, 100_000],
	];
	const spacings = [MIN_PAPER_SPACING, 1, 500];
	const whole = (p: Page) => ({ minX: 0, minY: 0, maxX: p.width, maxY: p.height });
	const paperPage = (kind: PaperKind, width: number, height: number, spacing: number): Page => ({ id: "p", width, height, paper: { kind, spacing }, strokes: [] });

	it.each(PAPER_KINDS_V7)("%s: at most MAX_PAPER_SEGMENTS lines, never blank, quickly", (kind) => {
		for (const [, w, h] of sizes) {
			for (const sp of spacings) {
				const p = paperPage(kind, w, h, sp);
				const started = performance.now();
				const { lines } = paperPattern(p, whole(p));
				const ms = performance.now() - started;
				expect(lines.length).toBeLessThanOrEqual(MAX_PAPER_SEGMENTS);
				expect(ms).toBeLessThan(1000);
				// Something is drawn whenever the full-size page has lines at this spacing (500 pt may leave none).
				if (sp <= 1) expect(lines.length).toBeGreaterThan(0);
			}
		}
	});

	it("calligraphy at 1 pt on A4 falls back to its major lines; hexagons at 1 pt on A0 to a coarser lattice", () => {
		const cal = paperPage("calligraphy", A4_WIDTH, A4_HEIGHT, 1);
		const lines = paperPattern(cal, whole(cal)).lines;
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((l) => l.kind !== "minor")).toBe(true);
		const hex = paperPage("hexagonal", 2384, 3370, 1);
		const edges = paperPattern(hex, whole(hex)).lines;
		expect(edges.length).toBeGreaterThan(1000);
		expect(edges.every((l) => l.kind === "minor")).toBe(true);
		// Edges of a coarser hexagon (side a power-of-two multiple of 1 pt).
		const longest = (ls: typeof edges) => Math.max(...ls.map((l) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1)));
		expect(longest(edges)).toBeGreaterThan(1.5);
		// The usual densities are untouched.
		const normal = paperPage("hexagonal", A4_WIDTH, A4_HEIGHT, PAPER_SPACING.hexagonal);
		const normalEdges = paperPattern(normal, whole(normal)).lines;
		expect(normalEdges.length).toBeLessThan(MAX_PAPER_SEGMENTS);
		expect(longest(normalEdges)).toBeCloseTo(PAPER_SPACING.hexagonal, 3);
	});

	it.each(PAPER_KINDS_V7)("%s: the exporters draw a dense page, within the bound and in time", (kind) => {
		const p = paperPage(kind, 2384, 3370, 1);
		const started = performance.now();
		const svg = pageToSvg(p);
		const pdf = new TextDecoder("latin1").decode(pagesToPdf([p]));
		expect(performance.now() - started).toBeLessThan(3000);
		expect((svg.match(/<path d="M/g) ?? []).length).toBeGreaterThan(0);
		expect(pdf).toContain(" l");
		const segments = (pdf.match(/ m -?[\d.]+ -?[\d.]+ l/g) ?? []).length;
		expect(segments).toBeGreaterThan(0);
		expect(segments).toBeLessThanOrEqual(MAX_PAPER_SEGMENTS);
	});
});
