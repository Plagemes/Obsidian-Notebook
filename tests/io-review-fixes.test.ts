import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { destinationVerdict, holdsPages } from "../src/library/page-move";
import { notebookUri } from "../src/integration/links";
import {
	companionClaim, companionContent, readRegionState, renderRegion, REGION_START, updateCompanionText, type CompanionTextDeps,
} from "../src/model/companion-content";
import { createDocument, createPage } from "../src/model/document";
import { History } from "../src/model/history";
import { backgroundRect } from "../src/model/margins";
import { createPdfPages } from "../src/model/pages";
import { serialize } from "../src/model/serialize";
import type { Asset, NotebookDocument, TextElement } from "../src/model/types";
import { makeFingerprint, matchRepublished, planRepublish, type NewSource, type OldSource } from "../src/pdf/republish";
import { conflictBaseOf, mayBeManualCopy, sameNotebookText } from "../src/storage/conflicts";
import { quickDocId } from "../src/storage/history";
import { DocumentSession, type DocumentIO, type Timers } from "../src/storage/session";
import { line, sampleDocument } from "./helpers";

// ------------------------------------------------------------------ move pages: the destination must hold them

describe("holdsPages (move to an open notebook)", () => {
	it("true only when the file text parses and contains every moved page", () => {
		const doc = sampleDocument(1);
		doc.pages.push(createPage());
		const text = serialize(doc);
		const ids = doc.pages.map((p) => p.id);
		expect(holdsPages(text, ids)).toBe(true);
		expect(holdsPages(text, [ids[1]!])).toBe(true);
		expect(holdsPages(text, [...ids, "not-there"])).toBe(false);
		expect(holdsPages(text.slice(0, 50), ids)).toBe(false);
		expect(holdsPages("", ids)).toBe(false);
		expect(holdsPages(text, [])).toBe(false);
	});

	it("the file decides: pages on disk are moved even if the flush failed because the user kept writing", () => {
		expect(destinationVerdict(true, true)).toBe("ok");
		expect(destinationVerdict(false, true)).toBe("ok");
		expect(destinationVerdict(true, false)).toBe("not-stored");
		expect(destinationVerdict(false, false)).toBe("not-saved");
	});
});

describe("quickDocId (is a notebook id unique in the vault)", () => {
	it("reads the id near the top, else falls back to a full parse", () => {
		const doc = sampleDocument(1);
		doc.id = "doc-xyz";
		expect(quickDocId(serialize(doc))).toBe("doc-xyz");
		// Another tool wrote the keys in another order, the id far from the top.
		const raw = JSON.parse(serialize(doc)) as Record<string, unknown>;
		const { format, version, id, ...rest } = raw;
		const late = JSON.stringify({ format, version, note: "x".repeat(700), id, ...rest });
		expect(late.indexOf('"id"')).toBeGreaterThan(600);
		expect(quickDocId(late)).toBe("doc-xyz");
		expect(quickDocId(`{"format":"obsidian-notebook","note":"${"x".repeat(700)}"}`)).toBeNull();
	});
});

// ------------------------------------------------------------------ session: saved state and own writes

const timers: Timers = {
	set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
	clear: (h) => clearTimeout(h),
};

class HookIO implements DocumentIO {
	onRead: (() => Promise<void> | void) | null = null;
	afterWrite: (() => void) | null = null;
	constructor(public content: string) {}
	async read(): Promise<string> {
		const hook = this.onRead;
		this.onRead = null;
		await hook?.();
		return this.content;
	}
	async process(fn: (current: string) => string): Promise<void> {
		this.content = fn(this.content);
		this.afterWrite?.();
	}
	async backup(): Promise<string | null> {
		return "backup.bak";
	}
}

describe("DocumentSession.isSaved / isOwnWrite", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("a flush that ends because the file was deleted meanwhile reports true, but isSaved() is false", async () => {
		const io = new HookIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers);
		await s.load();
		s.doc!.pages[0]!.strokes.push(line(1, 1, 50, 50));
		s.markChanged();
		const before = io.content;
		io.onRead = () => s.markDeleted();
		expect(await s.flush()).toBe(true);
		expect(io.content).toBe(before);
		expect(s.isSaved()).toBe(false);
	});

	it("isSaved() after a successful save; false while dirty", async () => {
		const io = new HookIO(serialize(sampleDocument(1)));
		const s = new DocumentSession(io, timers);
		await s.load();
		expect(s.isSaved()).toBe(true);
		s.doc!.pages[0]!.strokes.push(line(1, 1, 50, 50));
		s.markChanged();
		expect(s.isSaved()).toBe(false);
		await s.flush();
		expect(s.isSaved()).toBe(true);
		s.dispose();
		expect(s.isSaved()).toBe(false);
	});

	it("recognises its own write (also while it is being written), never content it only read", async () => {
		const loaded = serialize(sampleDocument(1));
		const io = new HookIO(loaded);
		const s = new DocumentSession(io, timers);
		await s.load();
		expect(s.isOwnWrite(loaded)).toBe(false);
		let duringWrite = false;
		io.afterWrite = () => {
			duringWrite = s.isOwnWrite(io.content);
		};
		s.doc!.pages[0]!.strokes.push(line(1, 1, 50, 50));
		s.markChanged();
		await s.flush();
		expect(duringWrite).toBe(true);
		const own = io.content;
		expect(s.isOwnWrite(own)).toBe(true);

		// Another device's version arrives and is loaded: not ours.
		const remote = sampleDocument(2);
		remote.id = s.doc!.id;
		io.content = serialize(remote);
		expect(await s.handleExternalChange()).toBe("reloaded");
		expect(s.isOwnWrite(io.content)).toBe(false);
		s.dispose();
	});
});

// ------------------------------------------------------------------ companion: one write, built as text

const PATH = "Notebooks/Physics.notebook";
const ctx = { notebookPath: PATH, pageUri: (p: number) => notebookUri("", PATH, p) };

function textEl(id: string, value: string): TextElement {
	return { id, type: "text", x: 10, y: 10, width: 200, text: value, fontSize: 14, color: "#000000" };
}

function companionDoc(body = "Newton"): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T14:30:00.000Z"));
	doc.id = "doc-1";
	doc.modifiedAt = "2026-10-29T14:42:00.000Z";
	doc.pages[0]!.elements = [textEl("a", body)];
	doc.meta = { tags: ["physics"], favorite: false, cover: "#3b82f6", bookmarks: [] };
	return doc;
}

/** Test stand-ins for Obsidian's frontmatter helpers: `key: <JSON>` lines. */
const deps: CompanionTextDeps = {
	frontmatterInfo(text) {
		const open = /^---\r?\n/.exec(text);
		if (!open) return { exists: false, from: 0, to: 0 };
		const from = open[0].length;
		const close = text.indexOf("\n---", from - 1);
		return close < 0 ? { exists: false, from: 0, to: 0 } : { exists: true, from, to: close + 1 };
	},
	parseFrontmatter(yaml) {
		const out: Record<string, unknown> = {};
		for (const raw of yaml.split(/\r?\n/)) {
			if (!raw.trim()) continue;
			const i = raw.indexOf(":");
			if (i < 0) return null;
			try {
				out[raw.slice(0, i).trim()] = JSON.parse(raw.slice(i + 1).trim());
			} catch {
				return null;
			}
		}
		return out;
	},
	stringify(data) {
		return Object.entries(data).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n";
	},
};

function build(text: string, doc = companionDoc()) {
	const content = companionContent(doc, ctx);
	return updateCompanionText(text, content, renderRegion(content), deps);
}

function changed(r: ReturnType<typeof build>): string {
	if (r.kind !== "changed") throw new Error(`expected a change, got ${r.kind}`);
	return r.text;
}

describe("updateCompanionText", () => {
	it("a note without frontmatter gets properties and region in one text; a second run changes nothing", () => {
		const out = changed(build("My own notes.\n"));
		expect(out.startsWith("---\n")).toBe(true);
		expect(out).toContain('notebook-id: "doc-1"');
		expect(out).toContain("My own notes.");
		expect(out).toContain(REGION_START);
		expect(out.indexOf("My own notes.")).toBeLessThan(out.indexOf(REGION_START));
		expect(build(out).kind).toBe("unchanged");
	});

	it("keeps user properties and user text, and owns only its properties", () => {
		const out = changed(build('---\nmine: "keep me"\nnotebook-id: "doc-1"\n---\nUser text above.\n'));
		const fm = deps.parseFrontmatter(out.slice(deps.frontmatterInfo(out).from, deps.frontmatterInfo(out).to))!;
		expect(fm.mine).toBe("keep me");
		expect(fm["notebook-id"]).toBe("doc-1");
		expect(fm.pages).toBe(1);
		expect(fm.tags).toEqual(["physics"]);
		expect(out).toContain("User text above.");
		expect(readRegionState(out)?.keys).toContain("notebook-id");
	});

	it("when only the generated text changes, the frontmatter stays byte for byte", () => {
		const first = changed(build("Intro\n"));
		// The user reformats a property of theirs (extra spaces): kept as written.
		const info = deps.frontmatterInfo(first);
		const edited = `${first.slice(0, info.to)}mine:    "x"\n${first.slice(info.to)}`;
		const next = changed(build(edited, companionDoc("Kepler")));
		const head = edited.slice(0, deps.frontmatterInfo(edited).to);
		expect(next.startsWith(head)).toBe(true);
		expect(next).toContain("Kepler");
		expect(next).not.toContain("Newton");
	});

	it("leaves the note alone when its YAML or its markers are broken", () => {
		expect(build("---\nthis is: not: [valid\n---\nbody\n").kind).toBe("yaml");
		const region = renderRegion(companionContent(companionDoc(), ctx));
		expect(build(`---\nmine: 1\n---\n${region}\n${region}\n`).kind).toBe("markers");
	});

	it("keeps CRLF line endings, also in the rewritten frontmatter", () => {
		const out = changed(build('---\r\nmine: "x"\r\n---\r\nText\r\n'));
		expect(out.replace(/\r\n/g, "")).not.toContain("\n");
		expect(build(out).kind).toBe("unchanged");
	});

	it("an empty frontmatter block is filled in place", () => {
		const out = changed(build("---\n---\nText\n"));
		expect(out.match(/^---$/gm)).toHaveLength(2);
		expect(out.startsWith('---\nnotebook: ')).toBe(true);
		expect(build(out).kind).toBe("unchanged");
	});
});

describe("companionClaim (who may use an existing companion note)", () => {
	it("a link to this notebook always wins; a link to another notebook never", () => {
		expect(companionClaim("this", false, false)).toBe("yes");
		expect(companionClaim("other", true, true)).toBe("no");
		expect(companionClaim("other", true, false)).toBe("no");
	});

	it("an unresolved link with the same id: at this notebook's own path yes, elsewhere only if the id is unique", () => {
		expect(companionClaim("none", true, true)).toBe("yes");
		expect(companionClaim("none", true, false)).toBe("if-unique");
		expect(companionClaim("none", false, true)).toBe("no");
	});
});

// ------------------------------------------------------------------ republished PDF: family and infinite pages

const OLD = "aaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "bbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "cccccccccccccccccccccccc";
const V2 = "dddddddddddddddddddddddd";
const pdfAsset = (id: string): Asset => ({ id, kind: "pdf", path: `N/_assets/${id}.pdf`, name: `${id}.pdf`, bytes: 1 });
const slide = (title: string, course = "Physics") =>
	makeFingerprint([`${title}:`, `explained with several words on the slide about ${title}`, `Course of ${course} - University`]);
const THANKS = makeFingerprint(["Thank you for your attention!", "Questions?"]);

function sources(asset: string, titles: string[], course = "Physics"): OldSource[] {
	return titles.map((t, i) => ({ asset, page: i + 1, fp: t === "thanks" ? THANKS : slide(t, course) }));
}
function newPdf(titles: string[]): NewSource[] {
	return titles.map((t, i) => ({ page: i + 1, fp: t === "thanks" ? THANKS : slide(t) }));
}

describe("matchRepublished: the family", () => {
	it("one identical 'Thank you' slide does not pull an unrelated lecture into the family", () => {
		const old = [
			...sources(OLD, ["intro", "waves", "optics"]),
			...sources(OTHER, ["cells", "enzymes", "dna", "proteins", "thanks"], "Biology"),
		];
		const r = matchRepublished(old, newPdf(["intro", "waves", "optics", "lenses", "thanks"]), OLD);
		expect(r.family).toEqual([OLD]);
		expect(r.main).toBe(OLD);
		expect(r.matches.map((m) => m.status)).toEqual(["unchanged", "unchanged", "unchanged", "new", "new"]);
		expect(r.missing.every((o) => o.asset === OLD)).toBe(true);
	});

	it("an asset joins with several unchanged pages, or more than half of its slides", () => {
		const old = [
			...sources(OLD, ["intro", "waves"]),
			...sources(V2, ["lenses", "mirrors", "prisms", "fibres", "lasers"]),
			{ asset: OTHER, page: 1, fp: slide("summary") },
		];
		const r = matchRepublished(old, newPdf(["intro", "waves", "lenses", "mirrors", "prisms", "summary"]), OLD);
		expect(new Set(r.family)).toEqual(new Set([OLD, V2, OTHER]));
		expect(r.main).toBe(OLD);
		const two = matchRepublished([...sources(OTHER, ["a1", "a2", "summary"])], newPdf(["summary", "b2"]), OLD);
		expect(two.family).toEqual([OLD]);
		expect(two.matches[0]!.status).toBe("new");
	});

	it("without an anchor the main asset is the one with most unchanged pages", () => {
		const old = [...sources(V2, ["x1"]), ...sources(OLD, ["intro", "waves", "optics"])];
		const r = matchRepublished(old, newPdf(["intro", "waves", "optics", "x1"]), null);
		expect(r.main).toBe(OLD);
		expect(new Set(r.family)).toEqual(new Set([OLD, V2]));
	});
});

describe("planRepublish: infinite pages keep their height", () => {
	function doc(margins: boolean): NotebookDocument {
		const d = createDocument(new Date("2026-10-29T10:00:00.000Z"));
		const old = pdfAsset(OLD);
		d.assets = { [OLD]: old };
		const [page] = createPdfPages(old, [{ width: 600, height: 400 }]);
		page!.infinite = true;
		page!.height = 1200;
		if (margins) {
			page!.margins = { left: 0, right: 100, bottom: 0 };
			page!.width = 700;
		}
		page!.strokes.push(line(10, 1100, 300, 1150));
		d.pages = [page!];
		return d;
	}
	const updated = () => matchRepublished(
		[{ asset: OLD, page: 1, fp: slide("waves") }],
		[{ page: 1, fp: makeFingerprint(["waves:", "explained with several words on the slide about waves, corrected", "Course of Physics - University"]) }],
		OLD,
	);

	it("without margins the page keeps its height", () => {
		const d = doc(false);
		const r = updated();
		expect(r.matches[0]!.status).toBe("updated");
		const plan = planRepublish(d, r, pdfAsset(NEW), [{ width: 600, height: 450 }], new Set([1]));
		expect(plan.switched).toBe(1);
		new History(() => d).execute(plan.command!);
		expect(d.pages[0]!.height).toBe(1200);
		expect(d.pages[0]!.background).toEqual({ kind: "pdf", asset: NEW, page: 1 });
	});

	it("with margins the extra height goes into the bottom margin and the slide keeps its size; undo restores", () => {
		const d = doc(true);
		const before = JSON.parse(JSON.stringify(d.pages[0])) as unknown;
		const history = new History(() => d);
		const plan = planRepublish(d, updated(), pdfAsset(NEW), [{ width: 600, height: 450 }], new Set([1]));
		expect(plan.switched).toBe(1);
		history.execute(plan.command!);
		const page = d.pages[0]!;
		expect(page.height).toBe(1200);
		expect(page.margins).toEqual({ left: 0, right: 100, bottom: 750 });
		expect(backgroundRect(page)).toEqual({ x: 0, y: 0, width: 600, height: 450 });
		history.undo();
		expect(JSON.parse(JSON.stringify(d.pages[0])) as unknown).toEqual(before);
	});

	it("an infinite page shorter than the new slide grows to it", () => {
		const d = doc(false);
		d.pages[0]!.height = 300;
		const plan = planRepublish(d, updated(), pdfAsset(NEW), [{ width: 600, height: 450 }], new Set([1]));
		new History(() => d).execute(plan.command!);
		expect(d.pages[0]!.height).toBe(450);
	});
});

// ------------------------------------------------------------------ conflicted copies that may be intentional

describe("conflicted copies: intentional copies and identical content", () => {
	it("'Notes (1)' may be a manual copy; other sync-conflict names are not", () => {
		expect(conflictBaseOf("Notes (1)", new Set(["Notes"]))).toBe("Notes");
		expect(mayBeManualCopy("Notes (1)", "Notes")).toBe(true);
		expect(mayBeManualCopy("Notes (12)", "Notes")).toBe(true);
		expect(mayBeManualCopy("Notes (1)", "Other")).toBe(false);
		expect(mayBeManualCopy("Notes [Conflict]", "Notes")).toBe(false);
		expect(mayBeManualCopy("Notes-DESKTOP-AB12CD", "Notes")).toBe(false);
		expect(mayBeManualCopy("Notes (conflicted copy)", "Notes")).toBe(false);
	});

	it("identical content: same text, or the same document written differently", () => {
		const doc = sampleDocument(2);
		const text = serialize(doc);
		expect(sameNotebookText(text, text)).toBe(true);
		expect(sameNotebookText(text, JSON.stringify(JSON.parse(text)))).toBe(true);
		const edited = sampleDocument(3);
		edited.id = doc.id;
		expect(sameNotebookText(text, serialize(edited))).toBe(false);
		expect(sameNotebookText("{broken", "{broken!")).toBe(false);
	});
});
