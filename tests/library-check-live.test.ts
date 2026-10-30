import { describe, expect, it } from "vitest";
import { assetIdsIn, journalAssetIds, liveAssetIds, type JournalReader } from "../src/library/library-check-live";
import { LibraryCheckSeenStore, parseSeen, SEEN_PREFIX, serializeSeen } from "../src/library/library-check-seen";
import { AddAsset, DeletePage, History } from "../src/model/history";
import type { Asset } from "../src/model/types";
import { buildEntry } from "../src/storage/journal";
import type { LinkFileAdapter } from "../src/storage/pdf-links-store";
import { sampleDocument } from "./helpers";

const id = (n: number) => n.toString(16).padStart(24, "0");
const asset = (n: number): Asset => ({ id: id(n), kind: "pdf", path: `Notebooks/_assets/${id(n)}.pdf`, name: `file${n}`, bytes: 100 });

describe("what open notebooks hold", () => {
	it("finds the assets of the document, of the undo and redo history and of pending media", () => {
		const doc = sampleDocument(2);
		doc.assets = { [id(1)]: asset(1) };
		const history = new History(() => doc);
		// asset 3 was added and undone: the document no longer has it, only the redo stack names it
		history.execute(new AddAsset(asset(2)));
		history.execute(new AddAsset(asset(3)));
		history.undo();
		expect(doc.assets?.[id(3)]).toBeUndefined();
		const pending = [asset(4)];
		const r = assetIdsIn([doc, history.pending(), pending]);
		expect(r.incomplete).toBe(false);
		expect([...r.ids].sort()).toEqual([id(1), id(2), id(3), id(4)].sort());
	});

	it("a page deleted but still in the undo history keeps what its background names", () => {
		const doc = sampleDocument(1);
		const page = doc.pages[0]!;
		doc.pages.push({ ...page, id: "p2", strokes: [], background: { kind: "pdf", asset: id(9), page: 1 } as never });
		const history = new History(() => doc);
		history.execute(new DeletePage(doc.pages[1]!, 1));
		expect(doc.pages).toHaveLength(1);
		expect(assetIdsIn([doc, history.pending()]).ids.has(id(9))).toBe(true);
	});

	it("walks maps, sets and object keys, survives cycles and skips typed arrays", () => {
		const a: Record<string, unknown> = { name: "x" };
		a.self = a;
		const roots = [
			a, new Map([[id(1), { deep: [{ v: id(2) }] }]]), new Set([id(3)]), { [id(4)]: 1 }, new Float32Array(10), "short", 12, null, undefined,
		];
		const r = assetIdsIn(roots);
		expect(r.incomplete).toBe(false);
		expect([...r.ids].sort()).toEqual([id(1), id(2), id(3), id(4)]);
	});

	it("too much to walk, or something that throws, gives an incomplete answer", () => {
		const wide = Array.from({ length: 50 }, () => ({ a: 1 }));
		expect(assetIdsIn([wide], 10).incomplete).toBe(true);
		const bomb = new Proxy({}, { ownKeys: () => { throw new Error("boom"); } });
		expect(assetIdsIn([bomb]).incomplete).toBe(true);
	});
});

class FakeFs implements JournalReader {
	files = new Map<string, string>();
	folderExists = true;
	failList = false;
	failRead = new Set<string>();
	async exists(): Promise<boolean> {
		return this.folderExists;
	}
	async list(): Promise<string[]> {
		if (this.failList) throw new Error("no access");
		return [...this.files.keys()];
	}
	async read(path: string): Promise<string> {
		if (this.failRead.has(path)) throw new Error("locked");
		return this.files.get(path) ?? "";
	}
}

function entryText(...assets: Asset[]): string {
	const doc = sampleDocument(1);
	doc.assets = Object.fromEntries(assets.map((a) => [a.id, a]));
	const built = buildEntry("doc", 1, "2026-10-29T10:00:00.000Z", "{}", ["{}"], JSON.stringify(doc), "Notebooks/A.notebook");
	return built ? built.text : "";
}

describe("what the journal holds", () => {
	it("a missing journal folder is an empty journal", async () => {
		const fs = new FakeFs();
		fs.folderExists = false;
		expect(await journalAssetIds(fs, "journal")).toEqual({ ids: new Set(), incomplete: false });
	});

	it("collects the ids of every entry, and ignores files that are not journal slots", async () => {
		const fs = new FakeFs();
		fs.files.set("journal/doc.abc.o1.0.journal", entryText(asset(1)));
		fs.files.set("journal/doc.abc.o1.1.journal", entryText(asset(2)));
		fs.files.set("journal/readme.txt", "not a journal");
		const r = await journalAssetIds(fs, "journal");
		expect(r.incomplete).toBe(false);
		expect([...r.ids].sort()).toEqual([id(1), id(2)]);
	});

	it("a slot that cannot be read, is empty, torn or not a journal entry makes the answer incomplete", async () => {
		const good = entryText(asset(1));
		const bad: Array<(fs: FakeFs) => void> = [
			(fs) => { fs.files.set("journal/a.b.o.0.journal", good); fs.failRead.add("journal/a.b.o.0.journal"); },
			(fs) => fs.files.set("journal/a.b.o.0.journal", ""),
			(fs) => fs.files.set("journal/a.b.o.0.journal", good.slice(0, good.length / 2)),
			(fs) => fs.files.set("journal/a.b.o.0.journal", `{"format":"other","${id(1)}":1}`),
			(fs) => { fs.failList = true; },
		];
		for (const setup of bad) {
			const fs = new FakeFs();
			setup(fs);
			expect((await journalAssetIds(fs, "journal")).incomplete).toBe(true);
		}
		// a torn slot still gives the ids it shows
		const fs = new FakeFs();
		fs.files.set("journal/a.b.o.0.journal", good.slice(0, good.length / 2 + 200));
		const torn = await journalAssetIds(fs, "journal");
		expect(torn.incomplete).toBe(true);
	});

	it("puts the open notebooks and the journal together; a view that throws makes it incomplete", async () => {
		const fs = new FakeFs();
		fs.files.set("journal/a.b.o.0.journal", entryText(asset(1)));
		const ok = await liveAssetIds(() => [{ x: id(2) }], fs, "journal");
		expect([...ok.ids].sort()).toEqual([id(1), id(2)]);
		expect(ok.incomplete).toBe(false);
		const broken = await liveAssetIds(() => { throw new Error("view not ready"); }, fs, "journal");
		expect(broken.incomplete).toBe(true);
		expect(broken.ids.has(id(1))).toBe(true);
	});
});

class MemAdapter implements LinkFileAdapter {
	files = new Map<string, string>();
	folders = new Set<string>();
	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.folders.has(path);
	}
	async read(path: string): Promise<string> {
		const t = this.files.get(path);
		if (t === undefined) throw new Error("missing");
		return t;
	}
	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}
	async mkdir(path: string): Promise<void> {
		this.folders.add(path);
	}
}

describe("this device's record of first sightings", () => {
	const device = "0a1b2c3d";
	const store = (a: MemAdapter) => new LibraryCheckSeenStore(a, () => "Notebooks", device);

	it("round-trips deterministically and refuses what is not ours", () => {
		const text = serializeSeen(new Map([[id(2), 20], [id(1), 10]]), device);
		expect(text.indexOf(id(1))).toBeLessThan(text.indexOf(id(2)));
		const back = parseSeen(text);
		expect(back.ok).toBe(true);
		if (back.ok) expect([...back.seen]).toEqual([[id(1), 10], [id(2), 20]]);
		expect(parseSeen("").ok).toBe(false);
		expect(parseSeen("{ nope").ok).toBe(false);
		expect(parseSeen(`{"format":"other","version":1,"seen":{}}`).ok).toBe(false);
		expect(parseSeen(`{"format":"obsidian-notebook-library-check","version":9,"seen":{}}`).ok).toBe(false);
		expect(parseSeen(`{"format":"obsidian-notebook-library-check","version":1,"seen":{"zz":1}}`).ok).toBe(false);
	});

	it("is this device's own file in _meta; a missing file is an empty record", async () => {
		const a = new MemAdapter();
		const s = store(a);
		expect(s.path).toBe(`Notebooks/_meta/${SEEN_PREFIX}-${device}.json`);
		expect(await s.load()).toEqual(new Map());
		await s.save(new Map([[id(1), 5]]));
		expect(a.files.get(s.path)).toBe(serializeSeen(new Map([[id(1), 5]]), device));
		expect(await s.load()).toEqual(new Map([[id(1), 5]]));
	});

	it("never overwrites a file it cannot read: gives null, keeps a copy, and refuses to save", async () => {
		const a = new MemAdapter();
		const s = store(a);
		a.files.set(s.path, `{"format":"obsidian-notebook-library-check","version":1,"seen":{ truncated`);
		expect(await s.load()).toBeNull();
		expect([...a.files.keys()].some((k) => k.includes(`${SEEN_PREFIX}.unreadable-`))).toBe(true);
		await expect(s.save(new Map([[id(1), 5]]))).rejects.toThrow();
		expect(a.files.get(s.path)).toContain("truncated");
		// an empty file (not synced yet) is not "nothing seen"
		a.files.set(s.path, "");
		expect(await s.load()).toBeNull();
		await expect(s.save(new Map())).rejects.toThrow();
		expect(a.files.get(s.path)).toBe("");
	});
});
