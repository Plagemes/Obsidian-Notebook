import { describe, expect, it, vi } from "vitest";
import { createPage } from "../src/model/document";
import {
	addEntry, emptyPageTrash, entriesToDrop, makeEntry, mergeEntries, parsePageTrashEntry, PAGE_TRASH_MAX_ENTRIES, planPageTrashRestore,
	PAGE_TRASH_RETENTION_DAYS, serializePageTrash, serializePageTrashEntry,
} from "../src/model/page-trash";
import { pageTrashEntriesFolder, pageTrashEntryPath, pageTrashPath } from "../src/storage/trash-paths";
import { FakeVault } from "./fake-vault";
import { sampleDocument } from "./helpers";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

const { PageTrashStore } = await import("../src/storage/page-trash-store");
const { deletePageKeepingCopy, restoreDeletedPage, stashDeletedPage } = await import("../src/view/page-tools");

const DAY = 86_400_000;
const ROOT = "Notebooks";

function threePages() {
	const doc = sampleDocument(2);
	doc.pages.push(createPage(), createPage());
	return doc;
}

describe("page trash entries (pure)", () => {
	it("round-trips one entry per file and refuses other files", () => {
		const doc = threePages();
		const entry = makeEntry(doc, doc.pages[1]!, 1, 1000);
		const back = parsePageTrashEntry(serializePageTrashEntry(doc.id, entry));
		expect(back).toEqual({ ok: true, notebookId: doc.id, entry });
		expect(parsePageTrashEntry("{").ok).toBe(false);
		expect(parsePageTrashEntry(serializePageTrash(emptyPageTrash(doc.id))).ok).toBe(false);
		expect(parsePageTrashEntry(JSON.stringify({ format: "obsidian-notebook-page-trash-entry", version: 9, notebookId: "a", entry })).ok).toBe(false);
	});

	it("merges copies of the same entry once", () => {
		const doc = threePages();
		const a = makeEntry(doc, doc.pages[1]!, 1, 1000);
		const b = makeEntry(doc, doc.pages[2]!, 2, 2000);
		expect(mergeEntries([[a], [a, b], [b]]).map((e) => e.id)).toEqual([a.id, b.id]);
	});

	it("drops what addEntry drops: older copies of the same page, expired and excess entries", () => {
		const doc = threePages();
		const now = 100 * DAY;
		const old = makeEntry(doc, doc.pages[1]!, 1, now - (PAGE_TRASH_RETENTION_DAYS + 1) * DAY);
		const first = makeEntry(doc, doc.pages[2]!, 2, now - 2000);
		const again = makeEntry(doc, doc.pages[2]!, 2, now - 1000);
		const drop = entriesToDrop([old, first, again], now);
		expect([...drop].sort()).toEqual([old.id, first.id].sort());
		let file = emptyPageTrash(doc.id);
		for (const e of [old, first, again]) file = addEntry(file, e, now);
		expect(file.entries.map((e) => e.id)).toEqual([again.id]);
		const many = Array.from({ length: PAGE_TRASH_MAX_ENTRIES + 3 }, (_, i) => {
			const d = threePages();
			return makeEntry(d, d.pages[1]!, 1, now - 10_000 + i);
		});
		expect(entriesToDrop(many, now).size).toBe(3);
	});

	it("keeps the page's bookmark and its details (v7) and brings them back on restore, in the same undo step", () => {
		const doc = threePages();
		const page = doc.pages[1]!;
		doc.meta = { ...doc.meta!, bookmarks: [page.id], bookmarkInfo: { [page.id]: { title: "Proof", color: "#ff0000", category: "review" } } };
		const entry = JSON.parse(JSON.stringify(makeEntry(doc, page, 1, 1000)));
		doc.pages.splice(1, 1);
		doc.meta = { ...doc.meta, bookmarks: [], bookmarkInfo: undefined };
		const plan = planPageTrashRestore(doc, entry)!;
		plan.command.apply(doc);
		expect(doc.pages[1]!.id).toBe(page.id);
		expect(doc.meta!.bookmarks).toEqual([page.id]);
		expect(doc.meta!.bookmarkInfo?.[page.id]).toEqual({ title: "Proof", color: "#ff0000", category: "review" });
		plan.command.revert(doc);
		expect(doc.pages).toHaveLength(2);
		expect(doc.meta!.bookmarks).toEqual([]);
		// With an id clash the restored copy gets new ids, and the bookmark follows the new page id.
		const clash = planPageTrashRestore(doc, entry)!;
		clash.command.apply(doc);
		const again = planPageTrashRestore(doc, entry)!;
		again.command.apply(doc);
		const copy = doc.pages[again.pageIndex]!;
		expect(copy.id).not.toBe(page.id);
		expect(doc.meta!.bookmarks).toEqual([page.id, copy.id]);
		expect(doc.meta!.bookmarkInfo?.[copy.id]?.title).toBe("Proof");
	});

	it("does not add a bookmark for a page that had none", () => {
		const doc = threePages();
		const entry = makeEntry(doc, doc.pages[1]!, 1, 1000);
		doc.pages.splice(1, 1);
		planPageTrashRestore(doc, entry)!.command.apply(doc);
		expect(doc.meta!.bookmarks).toEqual([]);
	});

	it("puts every entry in a file of its own under the notebook's folder", () => {
		expect(pageTrashEntryPath(ROOT, "nb1", "e1")).toBe("Notebooks/_trash/pages/nb1/e1.json");
		expect(pageTrashEntriesFolder(ROOT, "a/b")).not.toContain("a/b");
	});
});

describe("PageTrashStore", () => {
	it("writes each deleted page once to its own file and never modifies it", async () => {
		const v = new FakeVault();
		const store = new PageTrashStore(v.app, () => ROOT);
		const doc = threePages();
		await store.add(doc, doc.pages[1]!, 1);
		await store.add(doc, doc.pages[2]!, 2);
		expect(v.log.filter((l) => l.startsWith("modify"))).toEqual([]);
		expect(v.log.filter((l) => l.startsWith("create"))).toHaveLength(2);
		expect((await store.read(doc.id)).entries).toHaveLength(2);
	});

	it("keeps the entries of two devices that deleted pages before syncing, and reads conflicted copies", async () => {
		const doc = threePages();
		// Device A and device B each deleted a page; sync brought both entry files, plus a conflicted copy of one.
		const a = makeEntry(doc, doc.pages[1]!, 1, Date.now() - 2000);
		const b = makeEntry(doc, doc.pages[2]!, 2, Date.now() - 1000);
		const folder = pageTrashEntriesFolder(ROOT, doc.id);
		const v = new FakeVault({
			[pageTrashEntryPath(ROOT, doc.id, a.id)]: serializePageTrashEntry(doc.id, a),
			[`${folder}/${b.id} (1).json`]: serializePageTrashEntry(doc.id, b),
			[pageTrashEntryPath(ROOT, doc.id, b.id)]: serializePageTrashEntry(doc.id, b),
			[`${folder}/broken.json`]: "{ not json",
		});
		const store = new PageTrashStore(v.app, () => ROOT);
		const read = await store.read(doc.id);
		expect(read.entries.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
		// Discarding removes the entry and its conflicted copy; the unreadable file is left alone.
		await store.discard(doc.id, b.id);
		expect((await store.read(doc.id)).entries.map((e) => e.id)).toEqual([a.id]);
		expect(v.files.has(`${folder}/broken.json`)).toBe(true);
		expect(v.files.has(`${folder}/${b.id} (1).json`)).toBe(false);
	});

	it("moves the old one-file layout over entry by entry, conflicted copies too, and deletes it only after", async () => {
		const doc = threePages();
		const a = makeEntry(doc, doc.pages[1]!, 1, Date.now() - 3000);
		const b = makeEntry(doc, doc.pages[2]!, 2, Date.now() - 2000);
		const c = makeEntry(doc, doc.pages[0]!, 0, Date.now() - 1000);
		const legacy = pageTrashPath(ROOT, doc.id);
		const conflict = legacy.replace(/\.json$/, " (conflicted copy).json");
		const v = new FakeVault({
			[legacy]: serializePageTrash({ ...emptyPageTrash(doc.id), entries: [a, b] }),
			[conflict]: serializePageTrash({ ...emptyPageTrash(doc.id), entries: [a, c] }),
			[pageTrashPath(ROOT, "other")]: serializePageTrash(emptyPageTrash("other")),
		});
		// The first attempt to write b fails: the old file must stay and b must still be listed.
		v.failCreate.add(pageTrashEntryPath(ROOT, doc.id, b.id));
		const store = new PageTrashStore(v.app, () => ROOT);
		const first = await store.read(doc.id);
		expect(first.entries.map((e) => e.id).sort()).toEqual([a.id, b.id, c.id].sort());
		expect(v.files.has(legacy)).toBe(true);
		expect(v.files.has(conflict)).toBe(false);
		const second = await store.read(doc.id);
		expect(second.entries.map((e) => e.id).sort()).toEqual([a.id, b.id, c.id].sort());
		expect(v.files.has(legacy)).toBe(false);
		expect(v.files.has(pageTrashPath(ROOT, "other"))).toBe(true);
		for (const e of [a, b, c]) expect(v.files.has(pageTrashEntryPath(ROOT, doc.id, e.id))).toBe(true);
	});

	it("never overwrites or moves an old-layout file it cannot read", async () => {
		const doc = threePages();
		const legacy = pageTrashPath(ROOT, doc.id);
		const v = new FakeVault({ [legacy]: "{ damaged" });
		const store = new PageTrashStore(v.app, () => ROOT);
		await store.add(doc, doc.pages[1]!, 1);
		expect(v.files.get(legacy)).toBe("{ damaged");
		expect((await store.read(doc.id)).entries).toHaveLength(1);
	});
});

describe("page tools: delete and restore", () => {
	function host(doc: ReturnType<typeof threePages>, saved = true) {
		const applied: unknown[] = [];
		return {
			applied,
			host: {
				app: {} as never,
				settings: { folder: ROOT } as never,
				editableDocument: () => doc,
				applyCommand: (cmd: { apply(d: unknown): void }) => {
					cmd.apply(doc);
					applied.push(cmd);
					return true;
				},
				flush: async () => saved,
			},
		};
	}

	it("does not delete the page when its copy cannot be kept", async () => {
		const doc = threePages();
		const { host: h } = host(doc);
		const failing = { add: async () => { throw new Error("disk full"); }, read: async () => emptyPageTrash(doc.id), discard: async () => undefined };
		const removed: number[] = [];
		expect(await stashDeletedPage(h, doc, doc.pages[1]!, 1, failing)).toBe(false);
		expect(await deletePageKeepingCopy(h, doc, doc.pages[1]!, 1, (i) => removed.push(i), failing)).toBe(false);
		expect(removed).toEqual([]);
	});

	it("deletes the page (at its current index) once the copy is on disk", async () => {
		const doc = threePages();
		const { host: h } = host(doc);
		const v = new FakeVault();
		const store = new PageTrashStore(v.app, () => ROOT);
		const page = doc.pages[2]!;
		const removed: number[] = [];
		expect(await deletePageKeepingCopy(h, doc, page, 2, (i) => removed.push(i), store)).toBe(true);
		expect(removed).toEqual([2]);
		expect((await store.read(doc.id)).entries).toHaveLength(1);
	});

	it("discards an entry after the restored page is saved, so it cannot be restored twice", async () => {
		const doc = threePages();
		const v = new FakeVault();
		const store = new PageTrashStore(v.app, () => ROOT);
		const page = doc.pages[1]!;
		await store.add(doc, page, 1);
		doc.pages.splice(1, 1);
		const [entry] = (await store.read(doc.id)).entries;
		const { host: h, applied } = host(doc, true);
		expect(await restoreDeletedPage(h, doc.id, entry!.id, store)).toBe("restored");
		expect(applied).toHaveLength(1);
		expect(doc.pages).toHaveLength(3);
		expect((await store.read(doc.id)).entries).toEqual([]);
		expect(await restoreDeletedPage(h, doc.id, entry!.id, store)).toBe("failed");
		expect(doc.pages).toHaveLength(3);
	});

	it("keeps the entry when the notebook could not be saved after the restore", async () => {
		const doc = threePages();
		const v = new FakeVault();
		const store = new PageTrashStore(v.app, () => ROOT);
		await store.add(doc, doc.pages[1]!, 1);
		doc.pages.splice(1, 1);
		const [entry] = (await store.read(doc.id)).entries;
		const { host: h } = host(doc, false);
		expect(await restoreDeletedPage(h, doc.id, entry!.id, store)).toBe("restored-unsaved");
		expect((await store.read(doc.id)).entries).toHaveLength(1);
	});
});

describe("library trash: folders with the user's other files", () => {
	const meta = (id: string, name: string, kind: "folder" | "notebook") =>
		JSON.stringify({ v: 1, id, kind, name, originalPath: `${ROOT}/${name}`, deletedAt: 0 });

	it("splits a folder into notebooks and other files, at every level", async () => {
		const { folderContents } = await import("../src/storage/trash");
		const v = new FakeVault({ [`${ROOT}/Course/a.notebook`]: "", [`${ROOT}/Course/sub/b.notebook`]: "", [`${ROOT}/Course/sub/notes.md`]: "", [`${ROOT}/Course/slides.pdf`]: "" });
		const { notebooks, others } = folderContents(v.vault.getFolderByPath(`${ROOT}/Course`) as never);
		expect(notebooks.map((f) => f.path).sort()).toEqual([`${ROOT}/Course/a.notebook`, `${ROOT}/Course/sub/b.notebook`]);
		expect(others.map((f) => f.path).sort()).toEqual([`${ROOT}/Course/slides.pdf`, `${ROOT}/Course/sub/notes.md`]);
	});

	it("auto-empty never removes a trashed folder that holds files other than notebooks", async () => {
		const { LibraryTrash } = await import("../src/storage/trash");
		const items = `${ROOT}/_trash/items`;
		const v = new FakeVault({
			[`${items}/aaa-11111/meta.json`]: meta("aaa-11111", "Mixed", "folder"),
			[`${items}/aaa-11111/Mixed/a.notebook`]: "",
			[`${items}/aaa-11111/Mixed/notes.md`]: "my notes",
			[`${items}/bbb-22222/meta.json`]: meta("bbb-22222", "Only", "folder"),
			[`${items}/bbb-22222/Only/b.notebook`]: "",
		});
		const trash = new LibraryTrash({ app: v.app, root: () => ROOT, retentionDays: () => 30 });
		const listed = await trash.list();
		expect(listed.map((i) => [i.id, trash.otherFiles(i).length])).toEqual(expect.arrayContaining([["aaa-11111", 1], ["bbb-22222", 0]]));
		expect(await trash.purgeExpired(365 * DAY)).toBe(1);
		expect(v.files.get(`${items}/aaa-11111/Mixed/notes.md`)).toBe("my notes");
		expect(v.files.has(`${items}/bbb-22222/Only/b.notebook`)).toBe(false);
	});
});
