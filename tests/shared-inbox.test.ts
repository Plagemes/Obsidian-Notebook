import { describe, expect, it } from "vitest";
import {
	InboxQueue, MAX_DISMISSED, MAX_ITEMS, MAX_SINCE, addDismissed, dismissKey, inboxKind, isInboxCandidate, normaliseDismissed, normaliseSince, notebookNameFor,
	resolveInboxFolder, sinceFor, sizeLabel, type InboxContext, type InboxItem,
} from "../src/library/shared-inbox-logic";
import { buildImageDocument, imagePage, prepareAppendImagePage, prepareAppendPdf, prepareImageElement } from "../src/library/shared-inbox-plan";
import { buildImagesDocument } from "../src/library/bulk-import-run";
import { scannedPage } from "../src/scan/pages";
import { planClosedEdit } from "../src/integration/api-plan";
import { createDocument, createPage } from "../src/model/document";
import { serialize, serializeChecked } from "../src/model/serialize";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings";
import { settingSpecs } from "../src/view/settings-schema";
import type { Asset } from "../src/model/types";

const ctx = (over: Partial<InboxContext> = {}): InboxContext => ({
	folder: "Attachments", notebooksFolder: "Notebooks", templatesFolder: "", notebookTemplatesFolder: "", ...over,
});

const item = (path: string, at: number, extra: Partial<InboxItem> = {}): InboxItem => ({
	path, name: path.slice(path.lastIndexOf("/") + 1), kind: path.endsWith(".pdf") ? "pdf" : "image", size: 1000, at, ...extra,
});

describe("resolveInboxFolder", () => {
	it("the setting wins", () => {
		expect(resolveInboxFolder("Inbox", "Attachments")).toBe("Inbox");
		expect(resolveInboxFolder(" /Inbox/Shared/ ", "/")).toBe("Inbox/Shared");
		expect(resolveInboxFolder("Inbox\\Shared", undefined)).toBe("Inbox/Shared");
	});
	it("empty follows Obsidian's attachments setting", () => {
		expect(resolveInboxFolder("", "Attachments")).toBe("Attachments");
		expect(resolveInboxFolder("", "/Attachments/")).toBe("Attachments");
		expect(resolveInboxFolder("", "/")).toBe("");
		expect(resolveInboxFolder("", "")).toBe("");
		expect(resolveInboxFolder("", undefined)).toBe("");
		expect(resolveInboxFolder("", 42)).toBe("");
	});
	it("'same folder as the note' has no fixed place: no inbox", () => {
		expect(resolveInboxFolder("", "./")).toBeNull();
		expect(resolveInboxFolder("", "./attachments")).toBeNull();
		expect(resolveInboxFolder("", ".")).toBeNull();
	});
	it("a slash typed as the setting is the vault root; paths that climb out are refused", () => {
		expect(resolveInboxFolder("/", "Attachments")).toBe("");
		expect(resolveInboxFolder("../x", "")).toBeNull();
		expect(resolveInboxFolder("", "../x")).toBeNull();
	});
});

describe("isInboxCandidate", () => {
	it("takes PDFs and images directly in the folder", () => {
		expect(isInboxCandidate("Attachments/a.pdf", ctx())).toBe(true);
		expect(isInboxCandidate("Attachments/A.PNG", ctx())).toBe(true);
		expect(isInboxCandidate("Attachments/p.jpeg", ctx())).toBe(true);
		expect(isInboxCandidate("Attachments/p.webp", ctx())).toBe(true);
		expect(isInboxCandidate("Attachments/p.gif", ctx())).toBe(true);
	});
	it("ignores other kinds, hidden files, subfolders and other folders", () => {
		expect(isInboxCandidate("Attachments/a.docx", ctx())).toBe(false);
		expect(isInboxCandidate("Attachments/p.heic", ctx())).toBe(false);
		expect(isInboxCandidate("Attachments/a.notebook", ctx())).toBe(false);
		expect(isInboxCandidate("Attachments/.a.pdf", ctx())).toBe(false);
		expect(isInboxCandidate("Attachments/sub/a.pdf", ctx())).toBe(false);
		expect(isInboxCandidate("Other/a.pdf", ctx())).toBe(false);
		expect(isInboxCandidate("AttachmentsX/a.pdf", ctx())).toBe(false);
	});
	it("the vault root: only files directly in it", () => {
		expect(isInboxCandidate("a.pdf", ctx({ folder: "" }))).toBe(true);
		expect(isInboxCandidate("Sub/a.pdf", ctx({ folder: "" }))).toBe(false);
	});
	it("never offers the plugin's own files", () => {
		const c = ctx({ folder: "Notebooks" });
		expect(isInboxCandidate("Notebooks/_assets/abc.pdf", ctx({ folder: "Notebooks/_assets" }))).toBe(false);
		expect(isInboxCandidate("Notebooks/_assets/abc.png", c)).toBe(false);
		expect(isInboxCandidate("Notebooks/_meta/x.pdf", ctx({ folder: "Notebooks/_meta" }))).toBe(false);
		expect(isInboxCandidate("Notebooks/_trash/items/x/a.pdf", ctx({ folder: "Notebooks/_trash/items/x" }))).toBe(false);
		expect(isInboxCandidate("Notebooks/_backup/a.pdf", ctx({ folder: "Notebooks/_backup" }))).toBe(false);
	});
	it("never offers templates", () => {
		expect(isInboxCandidate("Notebooks/_templates/a.pdf", ctx({ folder: "Notebooks/_templates" }))).toBe(false);
		expect(isInboxCandidate("Tpl/a.pdf", ctx({ folder: "Tpl", templatesFolder: "Tpl" }))).toBe(false);
		expect(isInboxCandidate("Tpl/n/a.png", ctx({ folder: "Tpl/n", templatesFolder: "Tpl" }))).toBe(false);
		expect(isInboxCandidate("NT/a.png", ctx({ folder: "NT", notebookTemplatesFolder: "NT" }))).toBe(false);
	});
	it("never offers an exported PDF: named after the notebook next to it", () => {
		const siblings = new Set(["maths", "physics"]);
		const c = ctx({ folder: "Notebooks", siblingNotebooks: siblings });
		expect(isInboxCandidate("Notebooks/Maths.pdf", c)).toBe(false);
		expect(isInboxCandidate("Notebooks/Maths 2.pdf", c)).toBe(false);
		expect(isInboxCandidate("Notebooks/Maths 12.pdf", c)).toBe(false);
		expect(isInboxCandidate("Notebooks/Chemistry.pdf", c)).toBe(true);
	});
});

describe("inboxKind", () => {
	it("by extension", () => {
		expect(inboxKind("a.PDF")).toBe("pdf");
		expect(inboxKind("a.png")).toBe("image");
		expect(inboxKind("a")).toBeNull();
		expect(inboxKind("a.txt")).toBeNull();
	});
});

describe("dismissals", () => {
	it("are bounded, deduplicated and tolerate corrupt data", () => {
		expect(normaliseDismissed(null)).toEqual([]);
		expect(normaliseDismissed("x")).toEqual([]);
		expect(normaliseDismissed({ a: 1 })).toEqual([]);
		expect(normaliseDismissed(["a|1", "a|1", 3, "", "b|2", "x".repeat(500)])).toEqual(["a|1", "b|2"]);
		const many = Array.from({ length: MAX_DISMISSED + 50 }, (_, i) => `f${i}|1`);
		const out = normaliseDismissed(many);
		expect(out).toHaveLength(MAX_DISMISSED);
		expect(out[out.length - 1]).toBe(`f${MAX_DISMISSED + 49}|1`);
	});
	it("addDismissed moves a repeated key to the end and forgets the oldest", () => {
		expect(addDismissed(["a|1", "b|2"], "a|1")).toEqual(["b|2", "a|1"]);
		const full = Array.from({ length: MAX_DISMISSED }, (_, i) => `f${i}|1`);
		const next = addDismissed(full, "new|1");
		expect(next).toHaveLength(MAX_DISMISSED);
		expect(next[0]).toBe("f1|1");
		expect(next[next.length - 1]).toBe("new|1");
	});
	it("a new file with the same name is a different key", () => {
		expect(dismissKey({ path: "A/x.pdf", at: 1000.4 })).toBe("A/x.pdf|1000");
		expect(dismissKey({ path: "A/x.pdf", at: 2000 })).not.toBe(dismissKey({ path: "A/x.pdf", at: 1000 }));
	});
});

describe("InboxQueue", () => {
	it("lists newest first, ties by name", () => {
		const q = new InboxQueue();
		q.add(item("A/b.pdf", 10));
		q.add(item("A/a.pdf", 10));
		q.add(item("A/c.png", 30));
		q.add(item("A/d.png", 5));
		expect(q.list().map((i) => i.name)).toEqual(["c.png", "a.pdf", "b.pdf", "d.png"]);
		expect(q.count()).toBe(4);
	});
	it("add, remove and rename report whether the list changed", () => {
		const q = new InboxQueue();
		expect(q.add(item("A/a.pdf", 1))).toBe(true);
		expect(q.add(item("A/a.pdf", 1))).toBe(false);
		expect(q.remove("A/zzz.pdf")).toBe(false);
		expect(q.rename("A/a.pdf", item("A/b.pdf", 1))).toBe(true);
		expect(q.list().map((i) => i.path)).toEqual(["A/b.pdf"]);
		expect(q.rename("A/b.pdf", null)).toBe(true);
		expect(q.count()).toBe(0);
		expect(q.remove("A/b.pdf")).toBe(false);
	});
	it("a dismissed file is hidden, not removed; the same path with a new time comes back", () => {
		const q = new InboxQueue();
		const a = item("A/a.pdf", 100);
		q.add(a);
		const stored = q.dismiss(a);
		expect(stored).toEqual(["A/a.pdf|100"]);
		expect(q.list()).toEqual([]);
		q.add(item("A/a.pdf", 200));
		expect(q.list().map((i) => i.at)).toEqual([200]);
		const restored = new InboxQueue(stored);
		restored.add(a);
		expect(restored.list()).toEqual([]);
	});
	it("reset replaces the files and reports a change only when the list differs", () => {
		const q = new InboxQueue();
		expect(q.reset([item("A/a.pdf", 1), item("A/b.png", 2)])).toBe(true);
		expect(q.reset([item("A/b.png", 2), item("A/a.pdf", 1)])).toBe(false);
		expect(q.reset([])).toBe(true);
	});
	it("prune forgets dismissals of files that are gone", () => {
		const a = item("A/a.pdf", 1);
		const b = item("A/b.pdf", 2);
		const q = new InboxQueue();
		q.add(a);
		q.add(b);
		q.dismiss(a);
		q.dismiss(b);
		q.remove(b.path);
		expect(q.prune()).toEqual([dismissKey(a)]);
	});
	it("lists at most MAX_ITEMS", () => {
		const q = new InboxQueue();
		for (let i = 0; i < MAX_ITEMS + 20; i++) q.add(item(`A/f${i}.pdf`, i));
		expect(q.list()).toHaveLength(MAX_ITEMS);
		expect(q.list()[0]!.at).toBe(MAX_ITEMS + 19);
	});
});

describe("since", () => {
	it("starts at the first look and keeps it", () => {
		const first = sinceFor({}, "Inbox", 5000);
		expect(first.since).toBe(5000);
		expect(first.map).toEqual({ Inbox: 5000 });
		const again = sinceFor(first.map, "Inbox", 9000);
		expect(again.since).toBe(5000);
		expect(again.map).toBe(first.map);
	});
	it("is per folder and bounded; corrupt data is empty", () => {
		let map = normaliseSince(null);
		for (let i = 0; i < MAX_SINCE + 4; i++) map = sinceFor(map, `F${i}`, 1000 + i).map;
		expect(Object.keys(map)).toHaveLength(MAX_SINCE);
		expect(normaliseSince([1, 2])).toEqual({});
		expect(normaliseSince({ a: "x", b: -1, c: 5 })).toEqual({ c: 5 });
	});
});

describe("names", () => {
	it("notebookNameFor drops the extension and tidies", () => {
		expect(notebookNameFor("Lecture_3_slides.pdf")).toBe("Lecture 3 slides");
		expect(notebookNameFor("Inbox/Photo 1.JPG")).toBe("Photo 1");
		expect(notebookNameFor(".pdf")).toBe("Shared file");
	});
	it("sizeLabel", () => {
		expect(sizeLabel(0)).toBe("");
		expect(sizeLabel(300)).toBe("1 KB");
		expect(sizeLabel(320 * 1024)).toBe("320 KB");
		expect(sizeLabel(1.5 * 1024 * 1024)).toBe("1.5 MB");
		expect(sizeLabel(25 * 1024 * 1024)).toBe("25 MB");
	});
});

describe("edits", () => {
	const pdf: Asset = { id: "a".repeat(24), kind: "pdf", path: "Notebooks/_assets/a.pdf", name: "slides.pdf", bytes: 10 };
	const img: Asset = { id: "b".repeat(24), kind: "image", path: "Notebooks/_assets/b.png", name: "board.png", bytes: 10 };
	const base = () => {
		const doc = createDocument(new Date(0), { width: 595, height: 842 }, { kind: "blank", spacing: 28 });
		return serialize(doc);
	};

	it("a PDF is appended as PDF pages sized like the PDF's pages", () => {
		const plan = planClosedEdit(base(), prepareAppendPdf(pdf, [{ width: 595, height: 842 }, { width: 842, height: 595 }]), new Date(1));
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.result).toEqual({ added: 2, page: 2 });
		const back = JSON.parse(plan.text) as { pages: Array<{ background?: { kind: string; asset: string; page: number }; width: number }>; assets: Record<string, unknown> };
		expect(back.pages).toHaveLength(3);
		expect(back.pages[1]!.background).toMatchObject({ kind: "pdf", asset: pdf.id, page: 1 });
		expect(back.pages[2]!.background).toMatchObject({ kind: "pdf", asset: pdf.id, page: 2 });
		expect(back.pages[2]!.width).toBe(842);
		expect(back.assets[pdf.id]).toBeDefined();
	});

	it("a PDF without pages is refused", () => {
		expect(() => planClosedEdit(base(), prepareAppendPdf(pdf, []), new Date(1))).toThrow(/no pages/);
	});

	it("an image becomes a page after the last, landscape or portrait by its aspect", () => {
		expect(imagePage(img, { width: 800, height: 400 }).width).toBeGreaterThan(imagePage(img, { width: 800, height: 400 }).height);
		expect(imagePage(img, { width: 400, height: 800 }).width).toBeLessThan(imagePage(img, { width: 400, height: 800 }).height);
		const plan = planClosedEdit(base(), prepareAppendImagePage(img, { width: 800, height: 400 }), new Date(1));
		expect(plan.ok && plan.result).toEqual({ added: 1, page: 2 });
		if (plan.ok) expect((JSON.parse(plan.text) as { pages: Array<{ background?: unknown }> }).pages[1]!.background).toMatchObject({ kind: "image", asset: img.id });
	});

	it("an image element goes on the page in view, or the last page when closed or out of range", () => {
		const doc = createDocument(new Date(0), { width: 595, height: 842 }, { kind: "blank", spacing: 28 });
		doc.pages = [createPage({ width: 595, height: 842 }, { kind: "blank", spacing: 28 }), createPage({ width: 595, height: 842 }, { kind: "blank", spacing: 28 }), createPage({ width: 595, height: 842 }, { kind: "blank", spacing: 28 })];
		const text = serialize(doc);
		const at = (index: number | null) => {
			const plan = planClosedEdit(text, prepareImageElement(img, { width: 600, height: 400 }, index), new Date(1));
			if (!plan.ok) throw plan.error;
			return plan.result.page;
		};
		expect(at(0)).toBe(1);
		expect(at(1)).toBe(2);
		expect(at(null)).toBe(3);
		expect(at(7)).toBe(3);
		expect(at(-1)).toBe(3);
		const plan = planClosedEdit(text, prepareImageElement(img, { width: 600, height: 400 }, 1), new Date(1));
		if (!plan.ok) throw plan.error;
		const page = (JSON.parse(plan.text) as { pages: unknown[] }).pages[1] as { elements: Array<{ type: string; asset: string; width: number; height: number }> };
		expect(page.elements).toHaveLength(1);
		expect(page.elements[0]).toMatchObject({ type: "image", asset: img.id });
		expect(page.elements[0]!.width).toBeLessThanOrEqual(595 * 0.6 + 0.01);
	});

	it("an unreadable notebook is never edited", () => {
		const plan = planClosedEdit("not json", prepareAppendImagePage(img, { width: 10, height: 10 }), new Date(1));
		expect(plan.ok).toBe(false);
	});

	it("a new notebook from an image has one page with the image and passes validation", () => {
		const doc = buildImageDocument(img, { width: 1200, height: 800 }, new Date(5));
		expect(doc.pages).toHaveLength(1);
		expect(doc.pages[0]!.background).toMatchObject({ kind: "image", asset: img.id });
		expect(doc.assets?.[img.id]).toBeDefined();
		expect(serializeChecked(doc).ok).toBe(true);
	});
});

describe("settings", () => {
	it("default to on and following Obsidian's attachments folder", () => {
		expect(DEFAULT_SETTINGS.sharedInbox).toBe(true);
		expect(DEFAULT_SETTINGS.sharedInboxFolder).toBe("");
	});
	it("read leniently", () => {
		expect(readSettings({ sharedInbox: false, sharedInboxFolder: "  Inbox  " })).toMatchObject({ sharedInbox: false, sharedInboxFolder: "Inbox" });
		expect(readSettings({ sharedInbox: "no", sharedInboxFolder: 3 })).toMatchObject({ sharedInbox: true, sharedInboxFolder: "" });
	});
	it("have rows in the Library section, the folder only while the feature is on", () => {
		const on = settingSpecs().find((s) => s.id === "sharedInbox");
		const folder = settingSpecs().find((s) => s.id === "sharedInboxFolder");
		expect(on?.section).toBe("library");
		expect(folder?.section).toBe("library");
		expect(folder?.visible?.({ ...DEFAULT_SETTINGS, sharedInbox: false }, { sync: false, timetable: false, timetableInUse: false })).toBe(false);
		expect(folder?.visible?.({ ...DEFAULT_SETTINGS, sharedInbox: true }, { sync: false, timetable: false, timetableInUse: false })).toBe(true);
	});
});

describe("one import path with the bulk import", () => {
	const img: Asset = { id: "c".repeat(24), kind: "image", path: "Notebooks/_assets/c.png", name: "shared.png", bytes: 10 };
	it("a new notebook from a shared image is the notebook the bulk import makes from that image", () => {
		const dims = { width: 1200, height: 800 };
		const shared = buildImageDocument(img, dims, new Date(5));
		const bulk = buildImagesDocument([scannedPage(img, dims.width, dims.height)], [img], new Date(5));
		expect(shared.pages.map((p) => [p.width, p.height, p.background])).toEqual(bulk.pages.map((p) => [p.width, p.height, p.background]));
		expect(shared.assets).toEqual(bulk.assets);
	});
});
