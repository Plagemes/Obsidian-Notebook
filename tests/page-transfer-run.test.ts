/**
 * The runner of merge / split / extract (library/page-transfer.ts) on an in-memory vault: the order of the writes, what the
 * source keeps when anything goes wrong, locked pages, the backups, the trash.
 */
import { describe, expect, it, vi } from "vitest";
import { createDocument, createPage, createStroke, quantizePoint } from "../src/model/document";
import { History } from "../src/model/history";
import { parse, serialize } from "../src/model/serialize";
import type { Asset, NotebookDocument } from "../src/model/types";
import { FakeVault } from "./fake-vault";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

const { extractPages, mergeNotebooks, splitNotebook } = await import("../src/library/page-transfer");
const { outcomeLines } = await import("../src/library/transfer-flows");

const FOLDER = "Notebooks";
const settings = { folder: FOLDER } as never;

function stroke(): ReturnType<typeof createStroke> {
	return createStroke("#112233", 2, [quantizePoint(10, 10, 0.5), quantizePoint(40, 30, 0.5)]);
}

function notebook(pages: number): NotebookDocument {
	const doc = createDocument(new Date("2026-11-01T10:00:00.000Z"));
	doc.pages = [];
	for (let i = 0; i < pages; i++) {
		const p = createPage();
		p.strokes.push(stroke(), stroke());
		doc.pages.push(p);
	}
	return doc;
}

const PDF: Asset = { id: "aa01", kind: "pdf", path: `${FOLDER}/_assets/aa01.pdf`, name: "slides.pdf", bytes: 10 };

interface World {
	vault: FakeVault;
	env: Parameters<typeof extractPages>[0];
	trashed: string[];
}

function world(files: Record<string, NotebookDocument>): World {
	const vault = new FakeVault();
	for (const [path, doc] of Object.entries(files)) vault.put(path, serialize(doc));
	vault.put(`${FOLDER}/_assets/aa01.pdf`, "%PDF");
	const app = { ...(vault.app as object), workspace: { getLeavesOfType: () => [] } } as never;
	const trashed: string[] = [];
	const trash = { trash: async (f: { path: string }) => void (trashed.push(f.path), await vault.vault.delete(f)) };
	return { vault, trashed, env: { app, settings: () => settings, trash: trash as never } };
}

const fileOf = (w: World, path: string) => w.vault.vault.getFileByPath(path) as never;
const read = (w: World, path: string): NotebookDocument => {
	const text = w.vault.files.get(path);
	if (text === undefined) throw new Error(`no file ${path}`);
	const r = parse(text);
	if (!r.ok) throw new Error(r.message);
	return r.doc;
};
const ids = (doc: NotebookDocument) => doc.pages.map((p) => p.id);
const backups = (w: World) => [...w.vault.files.keys()].filter((p) => p.startsWith(`${FOLDER}/_backup/`));

describe("extract pages", () => {
	it("move: the new notebook is written and read back before the pages leave the source", async () => {
		const src = notebook(4);
		src.assets = { aa01: PDF };
		src.pages[1]!.background = { kind: "pdf", asset: "aa01", page: 2 };
		const w = world({ [`${FOLDER}/Physics.notebook`]: src });
		const s = await extractPages(w.env, { source: fileOf(w, `${FOLDER}/Physics.notebook`), pageIds: [src.pages[1]!.id, src.pages[2]!.id], mode: "move", name: "Optics", folder: FOLDER, allowLocked: false });
		expect(s).toMatchObject({ added: 2, removed: 2, changed: 0, keptLocked: 0 });
		expect(s.destination.path).toBe(`${FOLDER}/Optics.notebook`);
		// order of writes: the new notebook first, the source afterwards
		const log = w.vault.log;
		expect(log.indexOf(`create ${FOLDER}/Optics.notebook`)).toBeGreaterThanOrEqual(0);
		expect(log.indexOf(`modify ${FOLDER}/Physics.notebook`)).toBeGreaterThan(log.indexOf(`create ${FOLDER}/Optics.notebook`));
		const made = read(w, `${FOLDER}/Optics.notebook`);
		expect(ids(made)).toEqual([src.pages[1]!.id, src.pages[2]!.id]);
		expect(made.pages[0]!.strokes).toHaveLength(2);
		expect(made.assets?.aa01).toBeDefined();
		expect(made.pages[0]!.background).toEqual({ kind: "pdf", asset: "aa01", page: 2 });
		const left = read(w, `${FOLDER}/Physics.notebook`);
		expect(ids(left)).toEqual([src.pages[0]!.id, src.pages[3]!.id]);
		// the source's previous version is kept
		expect(backups(w).length).toBeGreaterThan(0);
		expect([...w.vault.files.entries()].some(([p, text]) => p.startsWith(`${FOLDER}/_backup/`) && text === serialize(src))).toBe(true);
	});

	it("copy: the source is not written at all", async () => {
		const src = notebook(3);
		const w = world({ [`${FOLDER}/A.notebook`]: src });
		const before = w.vault.files.get(`${FOLDER}/A.notebook`);
		const s = await extractPages(w.env, { source: fileOf(w, `${FOLDER}/A.notebook`), pageIds: [src.pages[0]!.id], mode: "copy", name: "Copy", folder: FOLDER, allowLocked: false });
		expect(s).toMatchObject({ added: 1, removed: 0 });
		expect(w.vault.files.get(`${FOLDER}/A.notebook`)).toBe(before);
		expect(w.vault.log.filter((l) => l.startsWith("modify"))).toEqual([]);
		const made = read(w, `${FOLDER}/Copy.notebook`);
		expect(made.pages[0]!.id).not.toBe(src.pages[0]!.id);
	});

	it("a destination that cannot be created leaves the source untouched", async () => {
		const src = notebook(3);
		const w = world({ [`${FOLDER}/A.notebook`]: src });
		const before = w.vault.files.get(`${FOLDER}/A.notebook`);
		w.vault.failCreate.add(`${FOLDER}/Part.notebook`);
		await expect(extractPages(w.env, { source: fileOf(w, `${FOLDER}/A.notebook`), pageIds: [src.pages[0]!.id], mode: "move", name: "Part", folder: FOLDER, allowLocked: false })).rejects.toThrow("disk full");
		expect(w.vault.files.get(`${FOLDER}/A.notebook`)).toBe(before);
		expect(w.vault.log.filter((l) => l.startsWith("modify"))).toEqual([]);
	});

	it("a destination that does not hold the pages after writing leaves the source untouched", async () => {
		const src = notebook(3);
		const w = world({ [`${FOLDER}/A.notebook`]: src });
		const before = w.vault.files.get(`${FOLDER}/A.notebook`);
		// a sync client that blanks the new file before it is read back
		const read0 = w.vault.vault.read;
		w.vault.vault.read = async (f: { path: string }) => (f.path.endsWith("Part.notebook") ? "{}" : read0(f));
		await expect(extractPages(w.env, { source: fileOf(w, `${FOLDER}/A.notebook`), pageIds: [src.pages[0]!.id], mode: "move", name: "Part", folder: FOLDER, allowLocked: false })).rejects.toThrow();
		expect(w.vault.files.get(`${FOLDER}/A.notebook`)).toBe(before);
	});

	it("an unreadable source is never written", async () => {
		const w = world({});
		w.vault.put(`${FOLDER}/Broken.notebook`, "not a notebook");
		await expect(extractPages(w.env, { source: fileOf(w, `${FOLDER}/Broken.notebook`), pageIds: ["x"], mode: "move", name: "Part", folder: FOLDER, allowLocked: false })).rejects.toThrow();
		expect(w.vault.files.get(`${FOLDER}/Broken.notebook`)).toBe("not a notebook");
		expect(w.vault.log).toEqual([]);
	});

	it("locked pages stay in the source until the removal is confirmed", async () => {
		const src = notebook(3);
		src.pages[1]!.locked = true;
		const w = world({ [`${FOLDER}/A.notebook`]: src });
		const request = { source: fileOf(w, `${FOLDER}/A.notebook`), pageIds: [src.pages[0]!.id, src.pages[1]!.id], mode: "move" as const, name: "Part", folder: FOLDER };
		const refused = await extractPages(w.env, { ...request, allowLocked: false });
		expect(refused).toMatchObject({ added: 2, removed: 1, keptLocked: 1 });
		expect(ids(read(w, `${FOLDER}/A.notebook`))).toEqual([src.pages[1]!.id, src.pages[2]!.id]);
		// the copy in the new notebook is locked too
		expect(read(w, refused.destination.path).pages[1]!.locked).toBe(true);
		const allowed = await extractPages(w.env, { ...request, pageIds: [src.pages[1]!.id], name: "Locked", allowLocked: true });
		expect(allowed).toMatchObject({ added: 1, removed: 1, keptLocked: 0 });
		expect(ids(read(w, `${FOLDER}/A.notebook`))).toEqual([src.pages[2]!.id]);
	});

	it("moving every page leaves the source one blank page", async () => {
		const src = notebook(2);
		const w = world({ [`${FOLDER}/A.notebook`]: src });
		const s = await extractPages(w.env, { source: fileOf(w, `${FOLDER}/A.notebook`), pageIds: ids(src), mode: "move", name: "All", folder: FOLDER, allowLocked: false });
		expect(s.removed).toBe(2);
		const left = read(w, `${FOLDER}/A.notebook`);
		expect(left.pages).toHaveLength(1);
		expect(left.pages[0]!.strokes).toEqual([]);
		expect(read(w, s.destination.path).pages).toHaveLength(2);
	});
});

describe("split", () => {
	it("makes the second half a new notebook beside the first and removes it from the source", async () => {
		const src = notebook(5);
		src.meta!.cover = "#ff8800";
		const w = world({ [`${FOLDER}/Sub/Big.notebook`]: src });
		const s = await splitNotebook(w.env, { source: fileOf(w, `${FOLDER}/Sub/Big.notebook`), at: 2, name: "Big (part 2)", allowLocked: false });
		expect(s.destination.path).toBe(`${FOLDER}/Sub/Big (part 2).notebook`);
		expect(ids(read(w, `${FOLDER}/Sub/Big.notebook`))).toEqual(ids(src).slice(0, 2));
		const second = read(w, s.destination.path);
		expect(ids(second)).toEqual(ids(src).slice(2));
		expect(second.meta!.cover).toBe("#ff8800");
		expect(second.id).not.toBe(src.id);
	});

	it("refuses a split that would leave a half empty", async () => {
		const src = notebook(3);
		const w = world({ [`${FOLDER}/A.notebook`]: src });
		for (const at of [0, 3]) {
			await expect(splitNotebook(w.env, { source: fileOf(w, `${FOLDER}/A.notebook`), at, name: "x", allowLocked: false })).rejects.toThrow();
		}
		expect(w.vault.log).toEqual([]);
	});
});

describe("merge", () => {
	it("copies B's pages into A after the chosen page and leaves B alone", async () => {
		const a = notebook(3);
		const b = notebook(2);
		b.assets = { aa01: PDF };
		b.pages[0]!.background = { kind: "pdf", asset: "aa01", page: 1 };
		const w = world({ [`${FOLDER}/A.notebook`]: a, [`${FOLDER}/B.notebook`]: b });
		const bBefore = w.vault.files.get(`${FOLDER}/B.notebook`);
		const s = await mergeNotebooks(w.env, { into: fileOf(w, `${FOLDER}/A.notebook`), from: fileOf(w, `${FOLDER}/B.notebook`), after: 0, trashFrom: false, allowLocked: false });
		expect(s).toMatchObject({ added: 2, removed: 0, trashed: false });
		const merged = read(w, `${FOLDER}/A.notebook`);
		expect(merged.pages).toHaveLength(5);
		expect(merged.pages[0]!.id).toBe(a.pages[0]!.id);
		expect(merged.pages[3]!.id).toBe(a.pages[1]!.id);
		expect(merged.pages[1]!.strokes).toHaveLength(2);
		expect(merged.assets?.aa01).toBeDefined();
		expect(w.vault.files.get(`${FOLDER}/B.notebook`)).toBe(bBefore);
		// copies are new pages
		expect(merged.pages.slice(1, 3).some((p) => ids(b).includes(p.id))).toBe(false);
		expect(backups(w).length).toBeGreaterThan(0);
	});

	it("with the trash option B goes to the library trash after its pages are in A, and the ids follow", async () => {
		const a = notebook(1);
		const b = notebook(2);
		const w = world({ [`${FOLDER}/A.notebook`]: a, [`${FOLDER}/B.notebook`]: b });
		const s = await mergeNotebooks(w.env, { into: fileOf(w, `${FOLDER}/A.notebook`), from: fileOf(w, `${FOLDER}/B.notebook`), trashFrom: true, allowLocked: false });
		expect(s).toMatchObject({ added: 2, trashed: true, trashSkipped: null });
		expect(w.trashed).toEqual([`${FOLDER}/B.notebook`]);
		expect(ids(read(w, `${FOLDER}/A.notebook`))).toEqual([a.pages[0]!.id, ...ids(b)]);
		// the order: A written before B left
		expect(w.vault.log.indexOf(`modify ${FOLDER}/A.notebook`)).toBeLessThan(w.vault.log.indexOf(`delete ${FOLDER}/B.notebook`));
	});

	it("does not trash B when it has locked pages that were not confirmed, but still merges", async () => {
		const a = notebook(1);
		const b = notebook(2);
		b.pages[0]!.locked = true;
		const w = world({ [`${FOLDER}/A.notebook`]: a, [`${FOLDER}/B.notebook`]: b });
		const s = await mergeNotebooks(w.env, { into: fileOf(w, `${FOLDER}/A.notebook`), from: fileOf(w, `${FOLDER}/B.notebook`), trashFrom: true, allowLocked: false });
		expect(s).toMatchObject({ added: 2, trashed: false, trashSkipped: "changed", keptLocked: 1 });
		expect(w.trashed).toEqual([]);
		expect(w.vault.files.has(`${FOLDER}/B.notebook`)).toBe(true);
		const ok = await mergeNotebooks(w.env, { into: fileOf(w, `${FOLDER}/A.notebook`), from: fileOf(w, `${FOLDER}/B.notebook`), trashFrom: true, allowLocked: true });
		expect(ok.trashed).toBe(true);
		expect(w.trashed).toEqual([`${FOLDER}/B.notebook`]);
		// the copy of a locked page is locked
		expect(read(w, `${FOLDER}/A.notebook`).pages.filter((p) => p.locked === true)).toHaveLength(2);
	});

	it("does not trash B when it changed while it was merged", async () => {
		const a = notebook(1);
		const b = notebook(2);
		const w = world({ [`${FOLDER}/A.notebook`]: a, [`${FOLDER}/B.notebook`]: b });
		// B is written to after A was saved and before the trash (a sync client, another device)
		const edited = { ...b, pages: b.pages.map((p, i) => (i === 1 ? { ...p, strokes: [...p.strokes, stroke()] } : p)) };
		const process0 = w.vault.vault.process;
		w.vault.vault.process = async (f: { path: string }, fn: (data: string) => string) => {
			const r = await process0(f, fn);
			if (f.path === `${FOLDER}/A.notebook`) w.vault.files.set(`${FOLDER}/B.notebook`, serialize(edited));
			return r;
		};
		const s = await mergeNotebooks(w.env, { into: fileOf(w, `${FOLDER}/A.notebook`), from: fileOf(w, `${FOLDER}/B.notebook`), trashFrom: true, allowLocked: false });
		expect(s).toMatchObject({ trashed: false, trashSkipped: "changed", changed: 1 });
		expect(w.trashed).toEqual([]);
		expect(read(w, `${FOLDER}/B.notebook`).pages[1]!.strokes).toHaveLength(3);
	});

	it("a failing trash is reported and B stays", async () => {
		const a = notebook(1);
		const b = notebook(1);
		const w = world({ [`${FOLDER}/A.notebook`]: a, [`${FOLDER}/B.notebook`]: b });
		w.env.trash = { trash: async () => { throw new Error("locked by sync"); } } as never;
		const s = await mergeNotebooks(w.env, { into: fileOf(w, `${FOLDER}/A.notebook`), from: fileOf(w, `${FOLDER}/B.notebook`), trashFrom: true, allowLocked: false });
		expect(s).toMatchObject({ added: 1, trashed: false, trashSkipped: "failed" });
		expect(w.vault.files.has(`${FOLDER}/B.notebook`)).toBe(true);
	});

	it("never merges a notebook into itself, and never touches A when B is unreadable", async () => {
		const a = notebook(2);
		const w = world({ [`${FOLDER}/A.notebook`]: a });
		w.vault.put(`${FOLDER}/Bad.notebook`, "garbage");
		const before = w.vault.files.get(`${FOLDER}/A.notebook`);
		await expect(mergeNotebooks(w.env, { into: fileOf(w, `${FOLDER}/A.notebook`), from: fileOf(w, `${FOLDER}/A.notebook`), trashFrom: false, allowLocked: false })).rejects.toThrow();
		await expect(mergeNotebooks(w.env, { into: fileOf(w, `${FOLDER}/A.notebook`), from: fileOf(w, `${FOLDER}/Bad.notebook`), trashFrom: false, allowLocked: false })).rejects.toThrow();
		expect(w.vault.files.get(`${FOLDER}/A.notebook`)).toBe(before);
	});

	it("an A that changed on disk between the read and the write is not overwritten", async () => {
		const a = notebook(2);
		const b = notebook(1);
		const w = world({ [`${FOLDER}/A.notebook`]: a, [`${FOLDER}/B.notebook`]: b });
		const changed = serialize({ ...a, modifiedAt: "2030-01-01T00:00:00.000Z", pages: [...a.pages, createPage()] });
		const process0 = w.vault.vault.process;
		w.vault.vault.process = async (f: { path: string }, fn: (data: string) => string) => {
			if (f.path === `${FOLDER}/A.notebook`) w.vault.files.set(f.path, changed);
			return process0(f, fn);
		};
		await expect(mergeNotebooks(w.env, { into: fileOf(w, `${FOLDER}/A.notebook`), from: fileOf(w, `${FOLDER}/B.notebook`), trashFrom: false, allowLocked: false })).rejects.toThrow();
		expect(w.vault.files.get(`${FOLDER}/A.notebook`)).toBe(changed);
	});
});

describe("the notice", () => {
	it("says what stayed behind and what was not rewritten", () => {
		const dest = { basename: "New" } as never;
		const s = { added: 3, removed: 2, changed: 1, keptLocked: 1, renamed: 0, destination: dest, trashed: false, trashSkipped: null, textLinks: 2 };
		const lines = outcomeLines("extract", s, { moved: true, source: "Old" });
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("3");
		expect(lines.join(" ")).toContain("New");
		expect(outcomeLines("merge", { ...s, changed: 0, keptLocked: 0, textLinks: 0, trashed: true }, { moved: true, source: "Old" })).toHaveLength(1);
		expect(outcomeLines("merge", { ...s, changed: 0, keptLocked: 0, textLinks: 0, trashSkipped: "failed" }, { moved: true, source: "Old" })).toHaveLength(2);
	});
});

/** An open, editable view of `path`: its history, its edit context, a flush that writes the document to the vault. */
function openView(w: World, path: string, doc: NotebookDocument, opts: { refuse?: boolean } = {}): { history: History; doc: NotebookDocument } {
	const history = new History(() => doc);
	const file = w.vault.vault.getFileByPath(path) as never as { path: string };
	const ctx = {
		app: w.env.app, folder: FOLDER, file, doc, measure: () => ({ width: 0, height: 0 }),
		alive: () => true, addPending: () => undefined, removePending: () => undefined, currentPage: () => 0, visibleLocal: () => null,
		execute: (cmd: Parameters<History["execute"]>[0]) => (opts.refuse ? false : history.execute(cmd)),
		flush: async () => {
			w.vault.files.set(path, serialize(doc));
			return true;
		},
	};
	const view = { file, editContext: () => ctx };
	const app = w.env.app as unknown as { workspace: { getLeavesOfType: () => unknown[] } };
	app.workspace.getLeavesOfType = () => [{ view }];
	return { history, doc };
}

describe("open notebooks", () => {
	it("an open source loses the pages through its history (one undo step), also the confirmed locked ones", async () => {
		const src = notebook(4);
		src.pages[2]!.locked = true;
		const original = ids(src);
		const w = world({ [`${FOLDER}/A.notebook`]: src });
		const { history, doc } = openView(w, `${FOLDER}/A.notebook`, src);
		const fileBefore = w.vault.files.get(`${FOLDER}/A.notebook`);
		const s = await extractPages(w.env, { source: fileOf(w, `${FOLDER}/A.notebook`), pageIds: [original[1]!, original[2]!], mode: "move", name: "Part", folder: FOLDER, allowLocked: true });
		expect(s).toMatchObject({ added: 2, removed: 2 });
		expect(ids(doc)).toEqual([original[0]!, original[3]!]);
		// the file of an open notebook is the view's to write: the runner did not
		expect(w.vault.files.get(`${FOLDER}/A.notebook`)).toBe(fileBefore);
		expect(read(w, s.destination.path).pages).toHaveLength(2);
		history.undo();
		expect(doc.pages).toHaveLength(4);
		expect(doc.pages[2]!.locked).toBe(true);
	});

	it("an open source keeps its locked pages unless confirmed, and a refused edit leaves the pages in both", async () => {
		const src = notebook(3);
		src.pages[0]!.locked = true;
		const original = ids(src);
		const w = world({ [`${FOLDER}/A.notebook`]: src });
		const { doc } = openView(w, `${FOLDER}/A.notebook`, src);
		const s = await extractPages(w.env, { source: fileOf(w, `${FOLDER}/A.notebook`), pageIds: [original[0]!, original[1]!], mode: "move", name: "Part", folder: FOLDER, allowLocked: false });
		expect(s).toMatchObject({ added: 2, removed: 1, keptLocked: 1 });
		expect(ids(doc)).toEqual([original[0]!, original[2]!]);
		const src2 = parse(serialize(src));
		if (!src2.ok) throw new Error("parse");
		const w2 = world({ [`${FOLDER}/B.notebook`]: src2.doc });
		const open2 = openView(w2, `${FOLDER}/B.notebook`, src2.doc, { refuse: true });
		const s2 = await extractPages(w2.env, { source: fileOf(w2, `${FOLDER}/B.notebook`), pageIds: [original[2]!], mode: "move", name: "Part", folder: FOLDER, allowLocked: false });
		expect(s2).toMatchObject({ added: 1, removed: 0, changed: 1 });
		expect(open2.doc.pages.map((p) => p.id)).toContain(original[2]!);
	});

	it("an open source that was edited after the pages were planned keeps the edited page", async () => {
		const src = notebook(3);
		const original = ids(src);
		const w = world({ [`${FOLDER}/A.notebook`]: src });
		const { doc } = openView(w, `${FOLDER}/A.notebook`, src);
		// the user draws on page 2 while the new notebook is being created
		const create0 = w.vault.vault.create;
		w.vault.vault.create = async (path: string, text: string) => {
			const r = await create0(path, text);
			if (path.endsWith("Part.notebook")) doc.pages[1]!.strokes.push(stroke());
			return r;
		};
		const s = await extractPages(w.env, { source: fileOf(w, `${FOLDER}/A.notebook`), pageIds: [original[1]!, original[2]!], mode: "move", name: "Part", folder: FOLDER, allowLocked: false });
		expect(s).toMatchObject({ added: 2, removed: 1, changed: 1 });
		expect(ids(doc)).toEqual([original[0]!, original[1]!]);
		expect(doc.pages[1]!.strokes).toHaveLength(3);
	});

	it("merging into an open notebook inserts the pages through its history after the chosen page", async () => {
		const a = notebook(3);
		const b = notebook(2);
		const aIds = ids(a);
		const w = world({ [`${FOLDER}/A.notebook`]: a, [`${FOLDER}/B.notebook`]: b });
		const { history, doc } = openView(w, `${FOLDER}/A.notebook`, a);
		const s = await mergeNotebooks(w.env, { into: fileOf(w, `${FOLDER}/A.notebook`), from: fileOf(w, `${FOLDER}/B.notebook`), after: 1, trashFrom: false, allowLocked: false });
		expect(s.added).toBe(2);
		expect(doc.pages).toHaveLength(5);
		expect(doc.pages.map((p) => p.id).slice(0, 2)).toEqual([aIds[0]!, aIds[1]!]);
		expect(doc.pages[4]!.id).toBe(aIds[2]!);
		expect(read(w, `${FOLDER}/A.notebook`).pages).toHaveLength(5);
		history.undo();
		expect(ids(doc)).toEqual(aIds);
	});

	it("a destination that refuses the edit (read-only) leaves the source as it was", async () => {
		const a = notebook(1);
		const b = notebook(2);
		const w = world({ [`${FOLDER}/A.notebook`]: a, [`${FOLDER}/B.notebook`]: b });
		openView(w, `${FOLDER}/A.notebook`, a, { refuse: true });
		const before = w.vault.files.get(`${FOLDER}/B.notebook`);
		await expect(mergeNotebooks(w.env, { into: fileOf(w, `${FOLDER}/A.notebook`), from: fileOf(w, `${FOLDER}/B.notebook`), trashFrom: true, allowLocked: false })).rejects.toThrow();
		expect(w.vault.files.get(`${FOLDER}/B.notebook`)).toBe(before);
		expect(w.trashed).toEqual([]);
	});
});
