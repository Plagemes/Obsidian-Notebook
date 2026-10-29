import { describe, expect, it } from "vitest";
import { isReservedPath } from "../src/library/folders";
import { createDocument, createPage, createStroke } from "../src/model/document";
import { History } from "../src/model/history";
import {
	addEntry, emptyPageTrash, entryDocument, makeEntry, PAGE_TRASH_MAX_ENTRIES, PAGE_TRASH_RETENTION_DAYS, parsePageTrash,
	planPageTrashRestore, pruneEntries, restoreIndex, serializePageTrash, trashedAssetIds, visibleEntries, removeEntry,
} from "../src/model/page-trash";
import { parse, serializeChecked } from "../src/model/serialize";
import {
	BUILTIN_IDS, builtinTemplate, documentFromTemplate, pageFromTemplate, templateDocument, templateFileName, type BuiltinLabels,
} from "../src/model/templates";
import type { Asset, NotebookDocument } from "../src/model/types";
import {
	daysLeft, expiredIds, isInTrash, isValidTrashId, isWithin, newTrashId, pageTrashPath, parseTrashMeta, restorePath,
	serializeTrashMeta, sortTrash, templatesFolderPath, trashItemPath, trashMetaPath, type TrashMeta,
} from "../src/storage/trash-paths";
import { readTrashSettings } from "../src/storage/trash-settings";
import { line } from "./helpers";

const DAY = 86_400_000;

describe("trash paths", () => {
	it("lays items out in their own folder", () => {
		expect(trashItemPath("Notebooks", "abc-123456", "Physics.notebook")).toBe("Notebooks/_trash/items/abc-123456/Physics.notebook");
		expect(trashMetaPath("", "abc-123456")).toBe("_trash/items/abc-123456/meta.json");
		expect(pageTrashPath("Notebooks", "nb1")).toBe("Notebooks/_trash/pages/nb1.json");
	});

	it("recognises trash paths whatever the notebooks folder is", () => {
		expect(isInTrash("Notebooks/_trash/items/a/b.notebook")).toBe(true);
		expect(isInTrash("_trash/pages/x.json")).toBe(true);
		expect(isInTrash("Deep/Folder/_trash/items/a")).toBe(true);
		expect(isInTrash("Notebooks/Physics.notebook")).toBe(false);
		expect(isInTrash("Notebooks/_trashy/items/a")).toBe(false);
		expect(isInTrash("Notebooks/my_trash/items/a")).toBe(false);
	});

	it("keeps the trash and templates out of the library", () => {
		expect(isReservedPath("Notebooks/_trash", "Notebooks")).toBe(true);
		expect(isReservedPath("Notebooks/_trash/items/a/x.notebook", "Notebooks")).toBe(true);
		expect(isReservedPath("Notebooks/_templates/Cornell.notebook", "Notebooks")).toBe(true);
		expect(isReservedPath("Notebooks/School/_trash", "Notebooks")).toBe(false);
	});

	it("builds ids that are safe folder names", () => {
		const id = newTrashId(1_700_000_000_000, "AB-cd/ef!");
		expect(isValidTrashId(id)).toBe(true);
		expect(isValidTrashId("../x")).toBe(false);
		expect(isValidTrashId("a/b-123456")).toBe(false);
		expect(isValidTrashId(newTrashId(5, ""))).toBe(true);
	});

	it("round-trips the meta file and refuses anything else", () => {
		const meta: TrashMeta = { v: 1, id: "abc-123456", kind: "notebook", name: "Physics.notebook", originalPath: "Notebooks/School/Physics.notebook", deletedAt: 1000 };
		expect(parseTrashMeta(serializeTrashMeta(meta))).toEqual(meta);
		expect(parseTrashMeta("{")).toBeNull();
		expect(parseTrashMeta(JSON.stringify({ ...meta, kind: "other" }))).toBeNull();
		expect(parseTrashMeta(JSON.stringify({ ...meta, id: "../etc" }))).toBeNull();
		expect(parseTrashMeta(JSON.stringify({ ...meta, name: "a/b" }))).toBeNull();
		expect(parseTrashMeta(JSON.stringify({ ...meta, v: 2 }))).toBeNull();
	});

	it("sorts newest first", () => {
		expect(sortTrash([{ deletedAt: 1 }, { deletedAt: 3 }, { deletedAt: 2 }]).map((i) => i.deletedAt)).toEqual([3, 2, 1]);
	});

	it("isWithin", () => {
		expect(isWithin("A/B", "A")).toBe(true);
		expect(isWithin("A", "A")).toBe(true);
		expect(isWithin("AB/C", "A")).toBe(false);
	});

	it("templates folder: setting or default", () => {
		expect(templatesFolderPath("", "Notebooks")).toBe("Notebooks/_templates");
		expect(templatesFolderPath(" My/Templates/ ", "Notebooks")).toBe("My/Templates");
		expect(templatesFolderPath("..\\x", "Notebooks")).toBe("x");
	});
});

describe("restore naming", () => {
	const taken = (...paths: string[]) => (p: string) => paths.includes(p);

	it("goes back to the original path when it is free", () => {
		expect(restorePath("Notebooks/Physics.notebook", "notebook", taken())).toBe("Notebooks/Physics.notebook");
	});

	it("takes a free name when the original is taken, keeping the extension", () => {
		expect(restorePath("Notebooks/Physics.notebook", "notebook", taken("Notebooks/Physics.notebook"))).toBe("Notebooks/Physics 2.notebook");
		expect(restorePath("Notebooks/Physics.notebook", "notebook", taken("Notebooks/Physics.notebook", "Notebooks/Physics 2.notebook"))).toBe("Notebooks/Physics 3.notebook");
	});

	it("names folders without an extension, even with dots in the name", () => {
		expect(restorePath("Notebooks/School", "folder", taken("Notebooks/School"))).toBe("Notebooks/School 2");
		expect(restorePath("Notebooks/v1.2", "folder", taken("Notebooks/v1.2"))).toBe("Notebooks/v1.2 2");
	});

	it("works at the vault root", () => {
		expect(restorePath("Quick.notebook", "notebook", taken("Quick.notebook"))).toBe("Quick 2.notebook");
	});
});

describe("retention", () => {
	const items = [
		{ id: "a-000001", deletedAt: 1000 },
		{ id: "b-000002", deletedAt: 1000 + 20 * DAY },
	];

	it("never expires anything when auto-empty is off", () => {
		expect(expiredIds(items, 1000 + 400 * DAY, 0)).toEqual([]);
		expect(expiredIds(items, 1000 + 400 * DAY, -3)).toEqual([]);
	});

	it("expires items older than the setting, boundary included", () => {
		expect(expiredIds(items, 1000 + 30 * DAY, 30)).toEqual(["a-000001"]);
		expect(expiredIds(items, 1000 + 30 * DAY - 1, 30)).toEqual([]);
		expect(expiredIds(items, 1000 + 60 * DAY, 30)).toEqual(["a-000001", "b-000002"]);
	});

	it("counts the days left", () => {
		expect(daysLeft(0, 0, 30)).toBe(30);
		expect(daysLeft(0, 10 * DAY + 1, 30)).toBe(20);
		expect(daysLeft(0, 99 * DAY, 30)).toBe(0);
		expect(daysLeft(0, 0, 0)).toBeNull();
	});

	it("reads the settings and ignores bad values", () => {
		expect(readTrashSettings({})).toEqual({ trashRetentionDays: 0, templatesFolder: "" });
		expect(readTrashSettings({ trashRetentionDays: 14, templatesFolder: " T " })).toEqual({ trashRetentionDays: 14, templatesFolder: "T" });
		expect(readTrashSettings({ trashRetentionDays: -1 }).trashRetentionDays).toBe(0);
		expect(readTrashSettings({ trashRetentionDays: 1.5 }).trashRetentionDays).toBe(0);
		expect(readTrashSettings({ trashRetentionDays: 9999 }).trashRetentionDays).toBe(0);
		expect(readTrashSettings({ trashRetentionDays: "7" }).trashRetentionDays).toBe(0);
	});
});

function docWithPages(n: number): NotebookDocument {
	const doc = createDocument(new Date("2026-10-29T10:00:00.000Z"));
	doc.pages = [];
	for (let i = 0; i < n; i++) {
		const p = createPage();
		p.strokes.push(line(40, 40 + i, 200, 60 + i));
		doc.pages.push(p);
	}
	return doc;
}

describe("page trash", () => {
	it("keeps a deleted page as a validated one-page document", () => {
		const doc = docWithPages(3);
		const page = doc.pages[1]!;
		const entry = makeEntry(doc, page, 1, 5000);
		expect(entry.index).toBe(1);
		expect(entry.afterPageId).toBe(doc.pages[0]!.id);
		const saved = entryDocument(entry);
		expect(saved?.pages).toHaveLength(1);
		expect(saved?.pages[0]?.id).toBe(page.id);
		expect(saved?.pages[0]?.strokes[0]?.points).toEqual(page.strokes[0]!.points);
	});

	it("survives being written to a file and read back", () => {
		const doc = docWithPages(2);
		const file = addEntry(emptyPageTrash(doc.id), makeEntry(doc, doc.pages[1]!, 1, 1000), 1000);
		const back = parsePageTrash(serializePageTrash(file));
		expect(back.ok).toBe(true);
		if (back.ok) expect(entryDocument(back.file.entries[0]!)?.pages[0]?.id).toBe(doc.pages[1]!.id);
		expect(parsePageTrash("{").ok).toBe(false);
		expect(parsePageTrash(JSON.stringify({ format: "x" })).ok).toBe(false);
		expect(parsePageTrash(JSON.stringify({ format: "obsidian-notebook-page-trash", version: 99, notebookId: "a", entries: [] })).ok).toBe(false);
	});

	it("caps the number of entries and keeps the newest", () => {
		const doc = docWithPages(1);
		let file = emptyPageTrash(doc.id);
		const now = 10_000_000;
		for (let i = 0; i < PAGE_TRASH_MAX_ENTRIES + 5; i++) {
			const p = createPage();
			file = addEntry(file, makeEntry(doc, p, 0, now + i), now + i);
		}
		expect(file.entries).toHaveLength(PAGE_TRASH_MAX_ENTRIES);
		expect(Math.min(...file.entries.map((e) => e.deletedAt))).toBe(now + 5);
	});

	it("drops entries older than the retention and keeps younger ones", () => {
		const doc = docWithPages(1);
		const old = makeEntry(doc, createPage(), 0, 0);
		const fresh = makeEntry(doc, createPage(), 0, (PAGE_TRASH_RETENTION_DAYS - 1) * DAY);
		const now = PAGE_TRASH_RETENTION_DAYS * DAY;
		expect(pruneEntries([old, fresh], now)).toEqual([fresh]);
	});

	it("the same page deleted twice has one entry", () => {
		const doc = docWithPages(2);
		const page = doc.pages[1]!;
		let file = addEntry(emptyPageTrash(doc.id), makeEntry(doc, page, 1, 1000), 1000);
		file = addEntry(file, makeEntry(doc, page, 1, 2000), 2000);
		expect(file.entries).toHaveLength(1);
		expect(file.entries[0]!.deletedAt).toBe(2000);
		expect(removeEntry(file, file.entries[0]!.id).entries).toHaveLength(0);
	});

	it("hides pages that are in the notebook again (an undone delete)", () => {
		const doc = docWithPages(3);
		const page = doc.pages[2]!;
		const file = addEntry(emptyPageTrash(doc.id), makeEntry(doc, page, 2, 1000), 1000);
		expect(visibleEntries(file, doc)).toHaveLength(0);
		doc.pages.splice(2, 1);
		expect(visibleEntries(file, doc)).toHaveLength(1);
	});

	it("restores after the page that preceded it, as one undo step", () => {
		const doc = docWithPages(4);
		const [a, b, c, d] = doc.pages;
		const entry = makeEntry(doc, c!, 2, 1000);
		doc.pages.splice(2, 1); // a b d
		// The preceding page moved to the end: the restored page follows it.
		doc.pages.splice(1, 1);
		doc.pages.push(b!); // a d b
		expect(restoreIndex(doc, entry)).toBe(3);
		const plan = planPageTrashRestore(doc, entry)!;
		expect(plan.pageIndex).toBe(3);
		const history = new History(() => doc);
		history.execute(plan.command);
		expect(doc.pages.map((p) => p.id)).toEqual([a!.id, d!.id, b!.id, c!.id]);
		history.undo();
		expect(doc.pages.map((p) => p.id)).toEqual([a!.id, d!.id, b!.id]);
		history.redo();
		expect(doc.pages).toHaveLength(4);
	});

	it("falls back to the old position, clamped, when the preceding page is gone", () => {
		const doc = docWithPages(5);
		const entry = makeEntry(doc, doc.pages[4]!, 4, 1000);
		doc.pages.splice(3, 2); // the page and the one before it are gone: 3 pages left
		expect(restoreIndex(doc, entry)).toBe(3);
		const first = makeEntry(doc, doc.pages[0]!, 0, 1000);
		expect(restoreIndex(doc, first)).toBe(0);
	});

	it("keeps the ids when free and gives new ones on a clash", () => {
		const doc = docWithPages(2);
		const page = doc.pages[1]!;
		const entry = makeEntry(doc, page, 1, 1000);
		doc.pages.splice(1, 1);
		const free = planPageTrashRestore(doc, entry)!;
		new History(() => doc).execute(free.command);
		expect(doc.pages[1]!.id).toBe(page.id);
		// The page is back already (e.g. restored twice): the second copy is a new page with new ids.
		const again = planPageTrashRestore(doc, entry)!;
		new History(() => doc).execute(again.command);
		expect(doc.pages).toHaveLength(3);
		expect(new Set(doc.pages.map((p) => p.id)).size).toBe(3);
		const strokeIds = doc.pages.flatMap((p) => p.strokes.map((s) => s.id));
		expect(new Set(strokeIds).size).toBe(strokeIds.length);
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("brings back the assets of the page and lists them for a future clean-up", () => {
		const doc = docWithPages(2);
		const asset: Asset = { id: "ab12", kind: "pdf", path: "Notebooks/_assets/ab12.pdf", name: "Slides.pdf", bytes: 10 };
		doc.assets = { ab12: asset };
		doc.pages[1]!.background = { kind: "pdf", asset: "ab12", page: 3 };
		const entry = makeEntry(doc, doc.pages[1]!, 1, 1000);
		const file = addEntry(emptyPageTrash(doc.id), entry, 1000);
		expect([...trashedAssetIds(file)]).toEqual(["ab12"]);
		doc.pages.splice(1, 1);
		delete doc.assets.ab12;
		const plan = planPageTrashRestore(doc, entry)!;
		new History(() => doc).execute(plan.command);
		expect((doc.assets as Record<string, Asset> | undefined)?.ab12?.name).toBe("Slides.pdf");
		expect(doc.pages[1]!.background).toEqual({ kind: "pdf", asset: "ab12", page: 3 });
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("an unreadable entry is kept and cannot be restored", () => {
		const doc = docWithPages(2);
		const entry = { ...makeEntry(doc, doc.pages[1]!, 1, 1000), document: { format: "nope" } };
		expect(entryDocument(entry)).toBeNull();
		expect(planPageTrashRestore(doc, entry)).toBeNull();
		const file = addEntry(emptyPageTrash(doc.id), entry, 1000);
		expect(file.entries).toHaveLength(1);
	});
});

const LABELS: BuiltinLabels = {
	cue: "Cues", notes: "Notes", summary: "Summary", meetingTitle: "Meeting", date: "Date", attendees: "Attendees",
	agenda: "Agenda", decisions: "Decisions", actions: "Actions", todoTitle: "To do",
};

describe("templates", () => {
	it("built-in templates are valid documents that survive a save and load", () => {
		for (const id of BUILTIN_IDS) {
			const doc = builtinTemplate(id, LABELS);
			const checked = serializeChecked(doc, true);
			expect(checked.ok, id).toBe(true);
			if (!checked.ok) continue;
			const back = parse(checked.text);
			expect(back.ok, id).toBe(true);
			expect(doc.pages.length).toBeGreaterThan(0);
		}
	});

	it("saves a page with content, paper, size and background; the copy has new ids", () => {
		const doc = docWithPages(2);
		const page = doc.pages[1]!;
		page.paper = { kind: "ruled", spacing: 22 };
		page.width = 400;
		page.height = 600;
		const asset: Asset = { id: "cd34", kind: "image", path: "Notebooks/_assets/cd34.png", name: "bg.png", bytes: 5 };
		doc.assets = { cd34: asset };
		page.background = { kind: "image", asset: "cd34" };
		const tpl = templateDocument(doc, page);
		expect(tpl.id).not.toBe(doc.id);
		expect(tpl.pages).toHaveLength(1);
		const t0 = tpl.pages[0]!;
		expect(t0.id).not.toBe(page.id);
		expect(t0.paper).toEqual({ kind: "ruled", spacing: 22 });
		expect([t0.width, t0.height]).toEqual([400, 600]);
		expect(t0.background).toEqual({ kind: "image", asset: "cd34" });
		expect(t0.strokes[0]!.points).toEqual(page.strokes[0]!.points);
		expect(t0.strokes[0]!.id).not.toBe(page.strokes[0]!.id);
		expect(Object.keys(tpl.assets ?? {})).toEqual(["cd34"]);
		const checked = serializeChecked(tpl, true);
		expect(checked.ok).toBe(true);
	});

	it("each use gives a page with fresh ids", () => {
		const tpl = builtinTemplate("cornell", LABELS);
		const a = pageFromTemplate(tpl)!;
		const b = pageFromTemplate(tpl)!;
		expect(a.page.id).not.toBe(b.page.id);
		expect(a.page.id).not.toBe(tpl.pages[0]!.id);
		const ids = (p: typeof a.page) => [...p.strokes.map((s) => s.id), ...(p.elements ?? []).map((e) => e.id)];
		expect(ids(a.page).some((id) => ids(b.page).includes(id))).toBe(false);
		expect(a.page.paper).toEqual(tpl.pages[0]!.paper);
	});

	it("a new notebook from a template is a copy with its own identity", () => {
		const tpl = builtinTemplate("meeting", LABELS);
		const doc = documentFromTemplate(tpl);
		expect(doc.id).not.toBe(tpl.id);
		expect(doc.pages).toHaveLength(tpl.pages.length);
		expect(doc.pages[0]!.elements?.length).toBe(tpl.pages[0]!.elements?.length);
		expect(doc.meta?.tags).toEqual([]);
		expect(serializeChecked(doc, true).ok).toBe(true);
	});

	it("a template page can be added to a notebook with undo", () => {
		const doc = docWithPages(2);
		const made = pageFromTemplate(builtinTemplate("todo", LABELS))!;
		const history = new History(() => doc);
		const before = doc.pages.length;
		history.execute({
			label: "x",
			apply: (d) => void d.pages.splice(1, 0, made.page),
			revert: (d) => void d.pages.splice(d.pages.indexOf(made.page), 1),
		});
		expect(doc.pages).toHaveLength(before + 1);
		expect(serializeChecked(doc, true).ok).toBe(true);
		history.undo();
		expect(doc.pages).toHaveLength(before);
	});

	it("cleans file names", () => {
		expect(templateFileName(' Week: "plan"/#1 ')).toBe("Week plan 1");
		expect(templateFileName("...")).toBe("");
	});

	it("keeps stroke creation honest (sanity)", () => {
		expect(createStroke("#000000", 2, [], "shape").tool).toBe("shape");
	});
});
