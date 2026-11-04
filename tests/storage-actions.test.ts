/** What the Storage manager does to the vault: the checks that keep it from taking anything away (A1 duplicates, A2 journal, A4 unsaved). */
import { describe, expect, it, vi } from "vitest";
import { serialize } from "../src/model/serialize";
import { createPage } from "../src/model/document";
import { PAGE_SIZES, type Asset, type NotebookDocument } from "../src/model/types";
import { DEFAULT_SETTINGS } from "../src/settings";
import { FakeVault } from "./fake-vault";
import { sampleDocument } from "./helpers";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

const { hasPendingJournal, mergeDuplicates, recordsNameFile, repointAsset } = await import("../src/library/storage-actions");
type Env = import("../src/library/storage-actions").StorageEnv;

const id = (n: number) => n.toString(16).padStart(24, "0");
const asset = (n: number, ext: string): Asset => ({ id: id(n), kind: "image", path: `Notebooks/_assets/${id(n)}.${ext}`, name: `pic.${ext}`, bytes: 10 });
const journalName = (docId: string) => `cfg/journal/${docId.replace(/[^A-Za-z0-9_-]/g, "_")}.12345678.owner.0.journal`;

function docUsing(a: Asset): NotebookDocument {
	const doc = sampleDocument(1);
	doc.assets = { [a.id]: a };
	const page = createPage(PAGE_SIZES.a4);
	page.elements = [{ id: "el1", type: "image", asset: a.id, x: 0, y: 0, width: 50, height: 50, rotation: 0 }];
	doc.pages.push(page);
	return doc;
}

interface Rig {
	v: FakeVault;
	env: Env;
	leaves: unknown[];
}

function rig(journalFiles: string[] | null = null): Rig {
	const v = new FakeVault();
	const leaves: unknown[] = [];
	const vault = {
		...v.vault,
		getFiles: () => [...v.files.keys()].map((p) => v.vault.getFileByPath(p)!),
		readBinary: async (f: { path: string }) => new TextEncoder().encode(v.files.get(f.path) ?? "").buffer,
	};
	const app = { vault, fileManager: { trashFile: async () => undefined }, workspace: { getLeavesOfType: () => leaves } } as never;
	const env: Env = {
		app, settings: () => ({ ...DEFAULT_SETTINGS, folder: "Notebooks" }), trashNotebook: async () => undefined,
		journal: journalFiles === null ? undefined : { reader: { exists: async () => true, list: async () => journalFiles }, folder: "cfg/journal" },
	};
	return { v, env, leaves };
}

/** Puts a file in the fake vault with its size set (the fake files have size 0). */
function put(r: Rig, path: string, text: string): void {
	r.v.put(path, text);
	r.v.vault.getFileByPath(path)!.stat.size = text.length;
}

describe("A1: merging the same picture stored twice (same id, two extensions)", () => {
	const keep = asset(1, "png");
	const extraAsset = asset(1, "jpg");
	const group = (users: string[]) => ({
		hash: "h", size: 5, keep: { path: keep.path, id: keep.id, size: 5, mtime: 0 }, extraBytes: 5,
		extras: [{ file: { path: extraAsset.path, id: extraAsset.id, size: 5, mtime: 0 }, kind: "same-id" as const, users, blocked: [] }],
	}) as never;

	it("moves the extra file aside when no record names it", async () => {
		const r = rig();
		put(r, "Notebooks/A.notebook", serialize(docUsing(keep)));
		put(r, keep.path, "PIXEL");
		put(r, extraAsset.path, "PIXEL");
		const out = await mergeDuplicates(r.env, group(["Notebooks/A.notebook"]), "Notebooks");
		expect(out.moved).toHaveLength(1);
		expect(out.skipped).toEqual([]);
		expect(r.v.files.has(extraAsset.path)).toBe(false);
		expect([...r.v.files.keys()].some((p) => p.startsWith("Notebooks/_trash/assets/"))).toBe(true);
	});

	it("leaves it where it is while a notebook record names that very file (library covers and older devices read the path)", async () => {
		const r = rig();
		put(r, "Notebooks/A.notebook", serialize(docUsing(extraAsset)));
		put(r, keep.path, "PIXEL");
		put(r, extraAsset.path, "PIXEL");
		const out = await mergeDuplicates(r.env, group(["Notebooks/A.notebook"]), "Notebooks");
		expect(out.moved).toEqual([]);
		expect(out.skipped).toEqual([extraAsset.path]);
		expect(r.v.files.has(extraAsset.path)).toBe(true);
		expect(r.v.log.filter((l) => l.startsWith("rename"))).toEqual([]);
	});

	it("also checks the kept-folder notebooks (library trash, templates) the group lists as holders", async () => {
		const r = rig();
		put(r, "Notebooks/A.notebook", serialize(docUsing(keep)));
		put(r, "Notebooks/_trash/Old.notebook", serialize(docUsing(extraAsset)));
		put(r, keep.path, "PIXEL");
		put(r, extraAsset.path, "PIXEL");
		const g = group(["Notebooks/A.notebook"]) as unknown as { extras: Array<{ holders?: string[] }> };
		g.extras[0]!.holders = ["Notebooks/_trash/Old.notebook"];
		const out = await mergeDuplicates(r.env, g as never, "Notebooks");
		expect(out.moved).toEqual([]);
		expect(out.skipped).toEqual([extraAsset.path]);
		expect(r.v.files.has(extraAsset.path)).toBe(true);
	});

	it("also when the notebook that names it cannot be read, has edits waiting in the journal, or is open and busy", async () => {
		const r = rig();
		put(r, "Notebooks/Broken.notebook", "{ not a notebook");
		expect(await recordsNameFile(r.env, ["Notebooks/Broken.notebook"], extraAsset.path)).toBe(true);
		const doc = docUsing(keep);
		const j = rig([journalName(doc.id)]);
		put(j, "Notebooks/A.notebook", serialize(doc));
		expect(await recordsNameFile(j.env, ["Notebooks/A.notebook"], extraAsset.path)).toBe(true);
		const open = rig();
		put(open, "Notebooks/A.notebook", serialize(docUsing(keep)));
		open.leaves.push({ view: { file: { path: "Notebooks/A.notebook" }, editContext: () => null } });
		expect(await recordsNameFile(open.env, ["Notebooks/A.notebook"], extraAsset.path)).toBe(true);
		// A notebook that names only the file that stays does not hold the merge back.
		const fine = rig();
		put(fine, "Notebooks/A.notebook", serialize(docUsing(keep)));
		expect(await recordsNameFile(fine.env, ["Notebooks/A.notebook"], extraAsset.path)).toBe(false);
	});
});

describe("A2: a closed notebook with edits waiting in the journal is not rewritten", () => {
	const from = asset(1, "png");
	const to = asset(2, "png");

	it("is skipped as busy, untouched, with no backup made", async () => {
		const doc = docUsing(from);
		const r = rig([journalName(doc.id), "cfg/journal/someone-else.12345678.owner.0.journal"]);
		const text = serialize(doc);
		put(r, "Notebooks/A.notebook", text);
		const out = await repointAsset(r.env, from.id, to, ["Notebooks/A.notebook"]);
		expect(out.skipped).toEqual([{ path: "Notebooks/A.notebook", reason: "busy" }]);
		expect(out.updated).toEqual([]);
		expect(r.v.files.get("Notebooks/A.notebook")).toBe(text);
		expect(r.v.log).toEqual([]);
	});

	it("is rewritten when the journal holds only other notebooks entries, and left alone when the journal cannot be listed", async () => {
		const doc = docUsing(from);
		const ok = rig(["cfg/journal/someone-else.12345678.owner.0.journal"]);
		put(ok, "Notebooks/A.notebook", serialize(doc));
		const done = await repointAsset(ok.env, from.id, to, ["Notebooks/A.notebook"]);
		expect(done.updated).toEqual(["Notebooks/A.notebook"]);
		expect(ok.v.files.get("Notebooks/A.notebook")).toContain(to.id);

		const broken = rig([]);
		broken.env.journal = { reader: { exists: async () => true, list: async () => { throw new Error("no access"); } }, folder: "cfg/journal" };
		put(broken, "Notebooks/A.notebook", serialize(doc));
		const left = await repointAsset(broken.env, from.id, to, ["Notebooks/A.notebook"]);
		expect(left.skipped).toEqual([{ path: "Notebooks/A.notebook", reason: "busy" }]);
		expect(await hasPendingJournal(broken.env, doc.id)).toBe(true);
		expect(await hasPendingJournal(rig().env, doc.id)).toBe(false);
	});
});

describe("A4: an open notebook whose save did not go through yet", () => {
	it("is reported as changed but unsaved, not as failed", async () => {
		const from = asset(1, "png");
		const to = asset(2, "png");
		const r = rig();
		const doc = docUsing(from);
		put(r, "Notebooks/A.notebook", serialize(doc));
		const pending = new Set<string>();
		const ctx = {
			doc, addPending: (a: Asset) => void pending.add(a.id), removePending: (i: string) => void pending.delete(i),
			execute: (cmd: { apply(d: NotebookDocument): void }) => (cmd.apply(ctx.doc), true),
			flush: async () => false,
		};
		r.leaves.push({ view: { file: { path: "Notebooks/A.notebook" }, editContext: () => ctx } });
		const out = await repointAsset(r.env, from.id, to, ["Notebooks/A.notebook"]);
		expect(out.failed).toEqual([]);
		expect(out.updated).toEqual(["Notebooks/A.notebook"]);
		expect(out.openUpdated).toEqual(["Notebooks/A.notebook"]);
		expect(out.unsaved).toEqual(["Notebooks/A.notebook"]);
		expect(doc.assets?.[to.id]).toBeDefined();
		expect(pending.size).toBe(0);
		// Saved: not listed as unsaved.
		ctx.flush = async () => true;
		ctx.doc = docUsing(from);
		const again = await repointAsset(r.env, from.id, to, ["Notebooks/A.notebook"]);
		expect(again.unsaved).toEqual([]);
		expect(again.updated).toEqual(["Notebooks/A.notebook"]);
	});
});

describe("an open notebook that does not take the change", () => {
	it("is listed as skipped, not as updated", async () => {
		const from = asset(1, "png");
		const to = asset(2, "png");
		const r = rig();
		const doc = docUsing(from);
		put(r, "Notebooks/A.notebook", serialize(doc));
		const pending = new Set<string>();
		const ctx = { doc, addPending: (a: Asset) => void pending.add(a.id), removePending: (i: string) => void pending.delete(i), execute: () => false, flush: async () => true };
		r.leaves.push({ view: { file: { path: "Notebooks/A.notebook" }, editContext: () => ctx } });
		const out = await repointAsset(r.env, from.id, to, ["Notebooks/A.notebook"]);
		expect(out.updated).toEqual([]);
		expect(out.openUpdated).toEqual([]);
		expect(out.skipped).toEqual([{ path: "Notebooks/A.notebook", reason: "refused" }]);
		expect(doc.assets?.[to.id]).toBeUndefined();
		expect(pending.size).toBe(0);
	});
});
