import { describe, expect, it } from "vitest";
import { ASSET_GRACE_MS, type CheckConfig, type LiveReferences, type SeenStore, type VaultFileInfo } from "../src/library/library-check";
import { newStorageCache, scanStorage, sortNotebooks, totalsParts, type StorageReport, type StorageScanOptions, type StorageSource } from "../src/library/storage-scan";
import { cloneMeta, createPage } from "../src/model/document";
import { createExcerpt } from "../src/model/excerpts";
import { serialize } from "../src/model/serialize";
import { DEFAULT_META, PAGE_SIZES, type Asset, type NotebookDocument } from "../src/model/types";
import { assetIdFromHash, sha256Hex } from "../src/pdf/hash";
import { sampleDocument } from "./helpers";

const NOW = 1_000_000_000_000;
const OLD = NOW - 48 * 3_600_000;
const id = (n: number) => n.toString(16).padStart(24, "0");
const config: CheckConfig = { root: "Notebooks", backup: "Notebooks/_backup", now: NOW };
const MB = 1024 * 1024;

const image = (n: number, ext = "png", bytes = 100): Asset => ({ id: id(n), kind: "image", path: `Notebooks/_assets/${id(n)}.${ext}`, name: `pic${n}.${ext}`, bytes });
const pdf = (n: number): Asset => ({ id: id(n), kind: "pdf", path: `Notebooks/_assets/${id(n)}.pdf`, name: `doc${n}.pdf`, bytes: 100 });

/** A notebook that registers `assets`, and uses the images among them as page backgrounds / images on a second page. */
function docUsing(assets: Asset[], strokes = 2): NotebookDocument {
	const doc = sampleDocument(strokes);
	doc.assets = Object.fromEntries(assets.map((a) => [a.id, a]));
	const images = assets.filter((a) => a.kind === "image");
	if (images.length > 0) {
		const page = createPage(PAGE_SIZES.a4);
		page.elements = images.map((a, i) => ({ id: `el${i}-${a.id}`, type: "image" as const, asset: a.id, x: 10, y: 10, width: 50, height: 50, rotation: 0 }));
		doc.pages.push(page);
	}
	return doc;
}
const textUsing = (...assets: Asset[]) => serialize(docUsing(assets));

interface Fake {
	text?: string;
	/** Binary content of an asset file (its text form, for the tests). */
	bytes?: string;
	size?: number;
	mtime?: number;
	unreadable?: boolean;
}

class FakeVault implements StorageSource {
	reads: string[] = [];
	binary: string[] = [];
	readonly entries = new Map<string, Fake>();
	put(path: string, f: Fake): this {
		this.entries.set(path, f);
		return this;
	}
	files(): VaultFileInfo[] {
		return [...this.entries].map(([path, f]) => ({ path, size: f.size ?? f.bytes?.length ?? f.text?.length ?? 1, mtime: f.mtime ?? OLD }));
	}
	async read(path: string): Promise<string> {
		this.reads.push(path);
		const f = this.entries.get(path);
		if (!f || f.unreadable) throw new Error("not available");
		return f.text ?? "";
	}
	async readBinary(path: string): Promise<ArrayBuffer> {
		this.binary.push(path);
		const f = this.entries.get(path);
		if (!f || f.unreadable) throw new Error("not available");
		return new TextEncoder().encode(f.bytes ?? "").buffer;
	}
}

class MemSeen implements SeenStore {
	constructor(public map: Map<string, number> | null = new Map()) {}
	async load(): Promise<Map<string, number> | null> {
		return this.map ? new Map(this.map) : null;
	}
	async save(seen: ReadonlyMap<string, number>): Promise<void> {
		this.map = new Map(seen);
	}
}
const aged = (...ns: number[]) => new MemSeen(new Map(ns.map((n) => [id(n), NOW - ASSET_GRACE_MS - 1000])));
const noLive = async (): Promise<LiveReferences> => ({ ids: [], incomplete: false });

function run(src: FakeVault, over: Partial<StorageScanOptions> = {}): Promise<StorageReport> {
	return scanStorage(src, config, { cache: newStorageCache(), live: noLive, ...over });
}
const orphanIds = (r: StorageReport) => r.check.orphans.map((o) => o.id);

/** An asset file of the given size. */
const assetFile = (n: number, ext = "png", size = 5000): [string, Fake] => [`Notebooks/_assets/${id(n)}.${ext}`, { size }];

describe("unused files: nothing that anything could still use is ever listed", () => {
	it("lists a file no notebook, backup, trash, template or stamp names, once it has been unused for a day", async () => {
		const src = new FakeVault().put("Notebooks/A.notebook", { text: textUsing(image(1)) }).put(...assetFile(1)).put(...assetFile(2));
		const r = await run(src, { seen: aged(1, 2) });
		expect(r.check.complete).toBe(true);
		expect(orphanIds(r)).toEqual([id(2)]);
		// Not yet a day: seen for the first time, so not offered.
		const first = await run(src, { seen: new MemSeen() });
		expect(orphanIds(first)).toEqual([]);
	});

	it("a picture used only by a page in the page trash is not listed", async () => {
		const entry = JSON.stringify({ format: "obsidian-notebook-page-trash-entry", version: 1, notebookId: "doc", entry: { id: "e1", deletedAt: 1, index: 0, afterPageId: null, document: JSON.parse(serialize(docUsing([image(1)]))) as unknown } });
		const src = new FakeVault()
			.put("Notebooks/A.notebook", { text: textUsing() })
			.put("Notebooks/_trash/pages/doc/e1.json", { text: entry })
			.put(...assetFile(1)).put(...assetFile(2));
		const r = await run(src, { seen: aged(1, 2) });
		expect(orphanIds(r)).toEqual([id(2)]);
		expect(r.check.kept.count).toBe(1);
	});

	it("a picture used only by a page in a page-trash file of the first layout is not listed either", async () => {
		const file = JSON.stringify({ format: "obsidian-notebook-page-trash", version: 1, notebookId: "doc", entries: [{ id: "e1", deletedAt: 1, index: 0, afterPageId: null, document: { assets: { [id(1)]: {} } } }] });
		const src = new FakeVault().put("Notebooks/A.notebook", { text: textUsing() }).put("Notebooks/_trash/pages/doc.json", { text: file }).put(...assetFile(1));
		expect(orphanIds(await run(src, { seen: aged(1) }))).toEqual([]);
	});

	it("a picture used only by a deleted notebook (library trash) is not listed", async () => {
		const src = new FakeVault()
			.put("Notebooks/A.notebook", { text: textUsing() })
			.put("Notebooks/_trash/items/k1-abcdef/Old.notebook", { text: textUsing(image(1)) })
			.put(...assetFile(1));
		const r = await run(src, { seen: aged(1) });
		expect(orphanIds(r)).toEqual([]);
		expect(r.check.kept.count).toBe(1);
	});

	it("a picture used only by a notebook that has not been downloaded yet is not listed, and nothing is offered while it is missing", async () => {
		for (const text of ["", "\0\0\0\0", textUsing(image(1)).slice(0, 300)]) {
			const src = new FakeVault().put("Notebooks/A.notebook", { text: textUsing() }).put("Notebooks/Away.notebook", { text, size: text.length }).put(...assetFile(1)).put(...assetFile(2));
			const r = await run(src, { seen: aged(1, 2) });
			expect(r.check.complete).toBe(false);
			expect(r.check.orphans).toEqual([]);
			expect(r.check.notDownloaded).toContain("Notebooks/Away.notebook");
		}
	});

	it("a notebook that cannot be read right now (online-only) is not judged and protects everything", async () => {
		const src = new FakeVault().put("Notebooks/A.notebook", { text: textUsing() }).put("Notebooks/Cloud.notebook", { unreadable: true, size: 4000 }).put(...assetFile(1));
		const r = await run(src, { seen: aged(1) });
		expect(r.check.complete).toBe(false);
		expect(r.check.orphans).toEqual([]);
	});

	it("a picture used only by a notebook that no longer parses is not listed", async () => {
		const damaged = `{"format": "obsidian-notebook", "assets": {"${id(1)}": {` + "x".repeat(200);
		const src = new FakeVault().put("Notebooks/A.notebook", { text: textUsing() }).put("Notebooks/Broken.notebook", { text: damaged, mtime: OLD }).put(...assetFile(1)).put(...assetFile(2));
		const r = await run(src, { seen: aged(1, 2) });
		expect(r.check.unreadable.map((u) => u.path)).toEqual(["Notebooks/Broken.notebook"]);
		expect(r.check.orphans).toEqual([]);
		expect(r.notebooks.find((n) => n.path === "Notebooks/Broken.notebook")?.status).toBe("unreadable");
	});

	it("a notebook anywhere in the vault protects its pictures, in a custom templates folder too", async () => {
		const src = new FakeVault()
			.put("Notebooks/A.notebook", { text: textUsing() })
			.put("School/Maths/B.notebook", { text: textUsing(image(1)) })
			.put("MyTemplates/T.notebook", { text: textUsing(image(2)) })
			.put(...assetFile(1)).put(...assetFile(2)).put(...assetFile(3));
		const r = await run(src, { seen: aged(1, 2, 3) });
		expect(orphanIds(r)).toEqual([id(3)]);
	});

	it("a picture used only by version history or a backup copy is kept, not listed", async () => {
		const src = new FakeVault()
			.put("Notebooks/A.notebook", { text: textUsing() })
			.put("Notebooks/_backup/history/doc/20260101-1000.snapshot", { text: textUsing(image(1)) })
			.put("Notebooks/_backup/A 20260101-100000 before-move 0a1b2c3d.bak", { text: textUsing(image(2)) })
			.put(...assetFile(1)).put(...assetFile(2));
		const r = await run(src, { seen: aged(1, 2) });
		expect(r.check.orphans).toEqual([]);
		expect(r.check.kept.count).toBe(2);
	});

	it("every kind of use protects: the page background, an image on a page, an excerpt snapshot and the cover", async () => {
		const doc = docUsing([image(1), image(2), image(3), image(4)]);
		// 1: image element (docUsing), 2: also an element; make 3 the background, 4 an excerpt snapshot, and 5 the cover.
		doc.assets![id(5)] = image(5);
		doc.pages[0]!.background = { kind: "image", asset: id(3) };
		doc.pages[1]!.elements = [createExcerpt(doc, "Notebooks/A.notebook", doc.pages[0]!, { x: 0, y: 0, width: 40, height: 40 }, { x: 5, y: 5, width: 40, height: 40 }, id(4))];
		doc.meta = { ...cloneMeta(DEFAULT_META), coverArt: { kind: "image", asset: id(5) } };
		const src = new FakeVault().put("Notebooks/A.notebook", { text: serialize(doc) });
		for (let n = 1; n <= 6; n++) src.put(...assetFile(n));
		// 1 and 2 are registered but no longer drawn anywhere; the record still names them, so they are used (a record is a reference).
		const r = await run(src, { seen: aged(1, 2, 3, 4, 5, 6) });
		expect(orphanIds(r)).toEqual([id(6)]);
	});

	it("a picture used by a large notebook (thousands of strokes) is found", async () => {
		const big = serialize(docUsing([image(1)], 3000));
		expect(big.length).toBeGreaterThan(500_000);
		const src = new FakeVault().put("Notebooks/Big.notebook", { text: big }).put(...assetFile(1)).put(...assetFile(2));
		const r = await run(src, { seen: aged(1, 2) });
		expect(orphanIds(r)).toEqual([id(2)]);
	});

	it("a picture only an open notebook (its document, or its undo history) holds is not listed; if the open notebooks cannot be inspected nothing is", async () => {
		const src = new FakeVault().put("Notebooks/A.notebook", { text: textUsing() }).put(...assetFile(1)).put(...assetFile(2));
		const open = await run(src, { seen: aged(1, 2), live: async () => ({ ids: [id(1)], incomplete: false }) });
		expect(orphanIds(open)).toEqual([id(2)]);
		const blind = await run(src, { seen: aged(1, 2), live: async () => ({ ids: [], incomplete: true }) });
		expect(blind.check.complete).toBe(false);
		expect(blind.check.orphans).toEqual([]);
		const none = await scanStorage(src, config, { cache: newStorageCache(), seen: aged(1, 2) });
		expect(none.check.orphans).toEqual([]);
	});

	it("without the record of first sightings nothing is offered", async () => {
		const src = new FakeVault().put("Notebooks/A.notebook", { text: textUsing() }).put(...assetFile(1));
		expect(orphanIds(await run(src))).toEqual([]);
		expect(orphanIds(await run(src, { seen: new MemSeen(null) }))).toEqual([]);
	});

	it("a file modified in the last hour, or with no content yet, is not offered", async () => {
		const src = new FakeVault().put("Notebooks/A.notebook", { text: textUsing() })
			.put(`Notebooks/_assets/${id(1)}.png`, { size: 5000, mtime: NOW - 60_000 })
			.put(`Notebooks/_assets/${id(2)}.png`, { size: 0 })
			.put(...assetFile(3));
		const r = await run(src, { seen: aged(1, 2, 3) });
		expect(orphanIds(r)).toEqual([id(3)]);
	});

	it("only files named like assets directly in the assets folder are ever considered", async () => {
		const src = new FakeVault().put("Notebooks/A.notebook", { text: textUsing() })
			.put("Notebooks/_assets/readme.png", { size: 5000 })
			.put(`Notebooks/_assets/sub/${id(1)}.png`, { size: 5000 })
			.put(`Elsewhere/${id(2)}.png`, { size: 5000 })
			.put(...assetFile(3));
		const r = await run(src, { seen: aged(1, 2, 3) });
		expect(orphanIds(r)).toEqual([id(3)]);
	});
});

describe("sizes", () => {
	it("charges a notebook its file, the pictures only it uses, an equal share of the pictures it shares, its backups and its journal; the rows add up", async () => {
		const a = docUsing([image(1), image(2)]);
		const b = docUsing([image(2)]);
		const textA = serialize(a);
		const textB = serialize(b);
		const src = new FakeVault()
			.put("Notebooks/A.notebook", { text: textA })
			.put("Notebooks/B.notebook", { text: textB })
			.put(...assetFile(1, "png", 3000)).put(...assetFile(2, "png", 7000))
			.put("Notebooks/_backup/A 20260101-100000 before-move 0a1b2c3d.bak", { size: 900 })
			.put(`Notebooks/_backup/history/${a.id}/20260101-1000.snapshot`, { size: 400 })
			.put("Notebooks/_trash/items/k1-abcdef/Old.notebook", { size: 1000 });
		const r = await run(src, { seen: aged(), journals: async () => [{ name: `${a.id}.12345678.owner.0.journal`, size: 250 }, { name: "unknown.12345678.owner.0.journal", size: 99 }] });
		const rowA = r.notebooks.find((n) => n.name === "A")!;
		const rowB = r.notebooks.find((n) => n.name === "B")!;
		expect(rowA.fileBytes).toBe(textA.length);
		expect(rowA.ownAssetBytes).toBe(3000);
		expect(rowA.sharedAssetBytes).toBe(7000);
		expect(rowA.sharedShareBytes).toBe(3500);
		expect(rowA.backupBytes).toBe(1300);
		expect(rowA.backupCount).toBe(2);
		expect(rowA.journalBytes).toBe(250);
		expect(rowA.totalBytes).toBe(textA.length + 3000 + 3500 + 1300 + 250);
		expect(rowB.ownAssetBytes).toBe(0);
		expect(rowB.sharedAssetBytes).toBe(7000);
		expect(rowB.sharedShareBytes).toBe(3500);
		// The shared picture is split, never charged twice: the two rows hold the 10 000 bytes of pictures exactly once.
		expect(rowA.ownAssetBytes + rowA.sharedShareBytes + rowB.ownAssetBytes + rowB.sharedShareBytes).toBe(10_000);
		expect(r.totals.notebooks.bytes).toBe(textA.length + textB.length);
		expect(r.totals.assets.bytes).toBe(10_000);
		expect(r.totals.backups.bytes).toBe(1300);
		expect(r.totals.trash.bytes).toBe(1000);
		expect(r.totals.journal.bytes).toBe(349);
		expect(r.totals.bytes).toBe(r.totals.notebooks.bytes + 10_000 + 1300 + 1000 + 349);
	});

	it("backups of a name two notebooks share are counted in the totals, not charged to either", async () => {
		const src = new FakeVault()
			.put("Notebooks/One/Notes.notebook", { text: textUsing() })
			.put("Notebooks/Two/Notes.notebook", { text: textUsing() })
			.put("Notebooks/_backup/Notes 20260101-100000 before-move 0a1b2c3d.bak", { size: 900 });
		const r = await run(src, { seen: aged() });
		expect(r.notebooks.every((n) => n.backupBytes === 0)).toBe(true);
		expect(r.totals.backups.bytes).toBe(900);
	});

	it("sorts by size, name, files or backups, ties on the path", () => {
		const row = (name: string, total: number, assets: number, backups: number) => ({
			path: `Notebooks/${name}.notebook`, name, docId: null, status: "ok" as const, fileBytes: 0, ownAssetBytes: assets, sharedAssetBytes: 0, sharedShareBytes: 0, assetCount: 0,
			backupBytes: backups, backupCount: 0, journalBytes: 0, totalBytes: total,
		});
		const rows = [row("b", 10, 1, 9), row("a", 30, 0, 0), row("c", 20, 5, 1), row("d", 20, 5, 1)];
		expect(sortNotebooks(rows, "size").map((r) => r.name)).toEqual(["a", "c", "d", "b"]);
		expect(sortNotebooks(rows, "name").map((r) => r.name)).toEqual(["a", "b", "c", "d"]);
		expect(sortNotebooks(rows, "assets").map((r) => r.name)).toEqual(["c", "d", "b", "a"]);
		expect(sortNotebooks(rows, "backups").map((r) => r.name)).toEqual(["b", "c", "d", "a"]);
	});

	it("names the categories that take space, largest first", () => {
		const b = (bytes: number) => ({ count: bytes > 0 ? 1 : 0, bytes });
		const parts = totalsParts({ notebooks: b(10), assets: b(80), backups: b(0), trash: b(10), journal: b(0), other: b(0), bytes: 100 });
		expect(parts.map((p) => p.id)).toEqual(["assets", "notebooks", "trash"]);
		expect(parts[0]!.share).toBeCloseTo(0.8);
	});
});

describe("duplicate pictures", () => {
	it("two files of one picture under another extension are the same id: the extra can go, nothing else changes", async () => {
		const bytes = "PICTURE-A";
		const real = assetIdFromHash(await sha256Hex(new TextEncoder().encode(bytes).buffer));
		const a: Asset = { id: real, kind: "image", path: `Notebooks/_assets/${real}.png`, name: "a.png", bytes: bytes.length };
		const src = new FakeVault()
			.put("Notebooks/A.notebook", { text: textUsing(a) })
			.put(`Notebooks/_assets/${real}.png`, { bytes })
			.put(`Notebooks/_assets/${real}.jpg`, { bytes });
		const r = await run(src, { seen: aged() });
		expect(r.duplicates).toHaveLength(1);
		const g = r.duplicates[0]!;
		expect(g.keep.path).toBe(`Notebooks/_assets/${real}.png`);
		expect(g.extras[0]!.file.path).toBe(`Notebooks/_assets/${real}.jpg`);
		expect(g.extras).toHaveLength(1);
		expect(g.extras[0]!.kind).toBe("same-id");
		expect(g.extras[0]!.file.id).toBe(real);
		expect(g.extraBytes).toBe(bytes.length);
	});

	it("a copy under another id that a notebook uses is offered with the notebooks to repoint; the one named by its own content stays", async () => {
		const bytes = "PICTURE-B";
		const real = assetIdFromHash(await sha256Hex(new TextEncoder().encode(bytes).buffer));
		const copy = image(77);
		const src = new FakeVault()
			.put("Notebooks/A.notebook", { text: textUsing(copy) })
			.put("Notebooks/B.notebook", { text: textUsing(copy) })
			.put(`Notebooks/_assets/${real}.png`, { bytes })
			.put(`Notebooks/_assets/${id(77)}.png`, { bytes });
		const r = await run(src, { seen: aged() });
		const g = r.duplicates[0]!;
		expect(g.keep.id).toBe(real);
		expect(g.extras).toHaveLength(1);
		expect(g.extras[0]).toMatchObject({ kind: "other-id", users: ["Notebooks/A.notebook", "Notebooks/B.notebook"], blocked: [] });
	});

	it("a copy nothing uses is not a duplicate to merge (it is an unused file); a notebook that cannot be edited is only reported", async () => {
		const bytes = "PICTURE-C";
		const real = assetIdFromHash(await sha256Hex(new TextEncoder().encode(bytes).buffer));
		const unused = new FakeVault()
			.put("Notebooks/A.notebook", { text: textUsing() })
			.put(`Notebooks/_assets/${real}.png`, { bytes })
			.put(`Notebooks/_assets/${id(78)}.png`, { bytes });
		expect((await run(unused, { seen: aged() })).duplicates).toEqual([]);
		const broken = new FakeVault()
			.put("Notebooks/A.notebook", { text: textUsing() })
			.put("Notebooks/Broken.notebook", { text: `{"x": "${id(78)}"` + "y".repeat(100) })
			.put("Notebooks/B.notebook", { text: textUsing(image(78)) })
			.put(`Notebooks/_assets/${real}.png`, { bytes })
			.put(`Notebooks/_assets/${id(78)}.png`, { bytes });
		const g = (await run(broken, { seen: aged() })).duplicates[0]!;
		expect(g.extras[0]!.users).toEqual(["Notebooks/B.notebook"]);
		expect(g.extras[0]!.blocked).toEqual(["Notebooks/Broken.notebook"]);
	});

	it("reads only the pictures that share a size with another, and only once", async () => {
		const src = new FakeVault()
			.put("Notebooks/A.notebook", { text: textUsing(image(1), image(2), image(3)) })
			.put(`Notebooks/_assets/${id(1)}.png`, { bytes: "11111" })
			.put(`Notebooks/_assets/${id(2)}.png`, { bytes: "22222" })
			.put(`Notebooks/_assets/${id(3)}.png`, { bytes: "3333333333" })
			.put(`Notebooks/_assets/${id(4)}.pdf`, { bytes: "55555" });
		const cache = newStorageCache();
		const r = await scanStorage(src, config, { cache, live: noLive, seen: aged() });
		expect(r.duplicates).toEqual([]);
		expect(src.binary.sort()).toEqual([`Notebooks/_assets/${id(1)}.png`, `Notebooks/_assets/${id(2)}.png`]);
		await scanStorage(src, config, { cache, live: noLive, seen: aged() });
		expect(src.binary).toHaveLength(2);
	});

	it("a picture that cannot be read right now is counted, not judged", async () => {
		const src = new FakeVault()
			.put("Notebooks/A.notebook", { text: textUsing() })
			.put(`Notebooks/_assets/${id(1)}.png`, { bytes: "11111" })
			.put(`Notebooks/_assets/${id(2)}.png`, { bytes: "22222", unreadable: true });
		const r = await run(src, { seen: aged() });
		expect(r.unreadable).toBe(1);
		expect(r.duplicates).toEqual([]);
	});
});

describe("heavy pictures", () => {
	it("lists the pictures a readable notebook uses, largest first, from the listing alone", async () => {
		const src = new FakeVault()
			.put("Notebooks/A.notebook", { text: textUsing(image(1), image(2), image(4), pdf(5)) })
			.put(...assetFile(1, "png", 5 * MB)).put(...assetFile(2, "jpg", 3 * MB)).put(...assetFile(3, "png", 9 * MB))
			.put(...assetFile(4, "png", 10_000)).put(...assetFile(5, "pdf", 20 * MB));
		const r = await run(src, { seen: aged() });
		// 3 is big but unused (an unused file, not something to downscale), 4 is small, 5 is a PDF.
		expect(r.heavy.map((h) => h.file.id)).toEqual([id(1), id(2)]);
		expect(r.heavy[0]!.users).toEqual(["Notebooks/A.notebook"]);
		expect(src.binary).toEqual([]);
	});

	it("a notebook that cannot be read is reported as blocked, not as an editable user", async () => {
		const src = new FakeVault()
			.put("Notebooks/A.notebook", { text: textUsing(image(1)) })
			.put("Notebooks/Broken.notebook", { text: `{"x": "${id(1)}"` + "y".repeat(100), mtime: OLD })
			.put(...assetFile(1, "png", 5 * MB));
		const r = await run(src, { seen: aged() });
		expect(r.heavy[0]).toMatchObject({ users: ["Notebooks/A.notebook"], blocked: ["Notebooks/Broken.notebook"] });
	});
});

describe("old backups and conflicted copies in the scan", () => {
	it("offers old backups except the newest of each notebook, and copies identical to their notebook", async () => {
		const same = textUsing();
		const src = new FakeVault()
			.put("Notebooks/A.notebook", { text: same })
			.put("Notebooks/A (1).notebook", { text: same })
			.put("Notebooks/_backup/A 20200101-100000 before-move 0a1b2c3d.bak", { size: 10 })
			.put("Notebooks/_backup/A 20200201-100000 before-move 1a1b2c3d.bak", { size: 10 });
		const r = await scanStorage(src, { ...config, now: Date.parse("2026-11-01T00:00:00Z") }, { cache: newStorageCache(), live: noLive, seen: aged() });
		expect(r.oldBackups.map((b) => b.path)).toEqual(["Notebooks/_backup/A 20200101-100000 before-move 0a1b2c3d.bak"]);
		// Same text, but the id is the id in the text: the copy carries the same document id as its notebook.
		expect(r.conflictsIdentical.map((c) => c.path)).toEqual(["Notebooks/A (1).notebook"]);
		expect(r.conflictsIdentical[0]!.maybeManual).toBe(true);
		expect(r.conflictsDiffering).toEqual([]);
	});

	it("a copy that differs from its notebook, or has another id, is only reported", async () => {
		const a = sampleDocument(2);
		const edited = { ...a, pages: [...a.pages], modifiedAt: "2026-10-30T10:00:00.000Z" };
		edited.pages[0] = { ...a.pages[0]!, strokes: [...a.pages[0]!.strokes].slice(1) };
		const other = sampleDocument(2);
		const src = new FakeVault()
			.put("Notebooks/A.notebook", { text: serialize(a) })
			.put("Notebooks/A-DESKTOP-AB12CD.notebook", { text: serialize(edited) })
			.put("Notebooks/A (conflicted copy).notebook", { text: serialize(other) });
		const r = await run(src, { seen: aged() });
		expect(r.conflictsIdentical).toEqual([]);
		expect(r.conflictsDiffering.map((c) => c.path).sort()).toEqual(["Notebooks/A (conflicted copy).notebook", "Notebooks/A-DESKTOP-AB12CD.notebook"]);
	});

	it("a notebook that is not a conflicted copy of anything is left alone", async () => {
		const src = new FakeVault().put("Notebooks/Physics.notebook", { text: textUsing() }).put("Notebooks/Physics notes.notebook", { text: textUsing() }).put("Notebooks/Anatomy (1).notebook", { text: textUsing() });
		const r = await run(src, { seen: aged() });
		expect(r.conflictsIdentical).toEqual([]);
		expect(r.conflictsDiffering).toEqual([]);
	});
});

describe("a scan is cheap and can be stopped", () => {
	it("reads unchanged notebooks once", async () => {
		const src = new FakeVault().put("Notebooks/A.notebook", { text: textUsing() }).put("Notebooks/B.notebook", { text: textUsing() });
		const cache = newStorageCache();
		await scanStorage(src, config, { cache, live: noLive, seen: aged() });
		const first = src.reads.length;
		const again = await scanStorage(src, config, { cache, live: noLive, seen: aged() });
		expect(src.reads.length).toBe(first);
		// The row still knows its document id although the text was not read again.
		expect(again.notebooks.every((n) => n.docId !== null)).toBe(true);
	});

	it("stops at once when asked, and reports it", async () => {
		const src = new FakeVault();
		for (let i = 0; i < 6; i++) src.put(`Notebooks/N${i}.notebook`, { text: textUsing() });
		let calls = 0;
		const r = await scanStorage(src, config, { cache: newStorageCache(), live: noLive, seen: aged(), cancelled: () => ++calls > 3 });
		expect(r.cancelled).toBe(true);
		expect(r.check.cancelled).toBe(true);
		expect(r.notebooks).toEqual([]);
		expect(src.reads.length).toBeLessThan(6);
	});

	it("stops between the pictures too", async () => {
		const src = new FakeVault().put("Notebooks/A.notebook", { text: textUsing() });
		for (let i = 1; i <= 6; i++) src.put(`Notebooks/_assets/${id(i)}.png`, { bytes: "same-size" });
		let stopAfterNotebooks = false;
		const r = await scanStorage(src, config, {
			cache: newStorageCache(), live: noLive, seen: aged(),
			progress: (phase) => { if (phase === "notebooks") stopAfterNotebooks = true; },
			cancelled: () => stopAfterNotebooks && src.binary.length >= 2,
		});
		expect(r.cancelled).toBe(true);
		expect(src.binary.length).toBeLessThan(6);
	});

	it("gives the interface room to breathe and reports progress by phase", async () => {
		const src = new FakeVault();
		for (let i = 0; i < 9; i++) src.put(`Notebooks/N${i}.notebook`, { text: textUsing() });
		src.put(`Notebooks/_assets/${id(1)}.png`, { bytes: "xx" }).put(`Notebooks/_assets/${id(2)}.png`, { bytes: "yy" });
		let breaths = 0;
		const seen: string[] = [];
		await scanStorage(src, config, { cache: newStorageCache(), live: noLive, seen: aged(), breathe: async () => { breaths++; }, progress: (phase, done, total) => seen.push(`${phase}:${done}/${total}`) });
		expect(breaths).toBeGreaterThan(1);
		expect(seen).toContain("notebooks:9/9");
		expect(seen).toContain("images:2/2");
	});

	it("never fails on an empty vault", async () => {
		const r = await run(new FakeVault(), { seen: aged() });
		expect(r.notebooks).toEqual([]);
		expect(r.totals.bytes).toBe(0);
		expect(r.cancelled).toBe(false);
	});
});
