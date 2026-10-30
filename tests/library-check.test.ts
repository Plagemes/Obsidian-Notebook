import { describe, expect, it } from "vitest";
import {
	assetsDir, assetTrashDir, assetTrashPath, ASSET_GRACE_MS, hexTokens, isAssetFilePath, isNonHolderSidecar, keptFolders, moveOrphans, runLibraryCheck,
	scanNotebookText, type AssetFile, type CheckConfig, type CheckSource, type LiveReferences, type Mover, type RunOptions,
	type ScanCache, type SeenStore, type VaultFileInfo,
} from "../src/library/library-check";
import { serialize } from "../src/model/serialize";
import type { Asset } from "../src/model/types";
import { sampleDocument } from "./helpers";

const NOW = 1_000_000_000_000;
const OLD = NOW - 48 * 3_600_000;
const DAY = 24 * 3_600_000;
const id = (n: number) => n.toString(16).padStart(24, "0");

function notebookText(...assets: Asset[]): string {
	const doc = sampleDocument(2);
	doc.assets = Object.fromEntries(assets.map((a) => [a.id, a]));
	return serialize(doc);
}

function asset(n: number, kind: "pdf" | "image" = "pdf"): Asset {
	return { id: id(n), kind, path: `Notebooks/_assets/${id(n)}.${kind === "pdf" ? "pdf" : "png"}`, name: `file${n}`, bytes: 100 };
}

interface FakeFile {
	text?: string;
	size?: number;
	mtime?: number;
	/** reading throws (an online-only file) */
	unreadable?: boolean;
}

class FakeSource implements CheckSource {
	reads: string[] = [];
	constructor(readonly entries: Map<string, FakeFile> = new Map()) {}
	put(path: string, f: FakeFile): this {
		this.entries.set(path, f);
		return this;
	}
	files(): VaultFileInfo[] {
		return [...this.entries].map(([path, f]) => ({ path, size: f.size ?? f.text?.length ?? 1, mtime: f.mtime ?? OLD }));
	}
	async read(path: string): Promise<string> {
		this.reads.push(path);
		const f = this.entries.get(path);
		if (!f || f.unreadable) throw new Error("not available");
		return f.text ?? "";
	}
}

/** The record of first sightings, in memory. */
class MemSeen implements SeenStore {
	saves = 0;
	constructor(public map: Map<string, number> | null = new Map()) {}
	async load(): Promise<Map<string, number> | null> {
		return this.map ? new Map(this.map) : null;
	}
	async save(seen: ReadonlyMap<string, number>): Promise<void> {
		this.saves++;
		this.map = new Map(seen);
	}
}

/** Every asset id seen unused a long time ago, as after an earlier check. */
function agedSeen(...ids: number[]): MemSeen {
	return new MemSeen(new Map(ids.map((n) => [id(n), NOW - ASSET_GRACE_MS - 1000])));
}

const noLive = async (): Promise<LiveReferences> => ({ ids: [], incomplete: false });

/** Run options of a check that can be trusted: nothing open, and the given ids seen unused long ago. */
function opts(seen: SeenStore | undefined, over: Partial<RunOptions> = {}): RunOptions {
	return { live: noLive, ...(seen ? { seen } : {}), ...over };
}

const config: CheckConfig = { root: "Notebooks", backup: "Notebooks/_backup", now: NOW };

function assetFile(n: number, over: FakeFile = {}): [string, FakeFile] {
	return [`Notebooks/_assets/${id(n)}.pdf`, { size: 5000, ...over }];
}

function vault(): FakeSource {
	return new FakeSource();
}

describe("what counts as an asset file", () => {
	it("is a file directly in the assets folder named by a 24-digit id", () => {
		expect(isAssetFilePath(`Notebooks/_assets/${id(1)}.pdf`, "Notebooks")).toBe(true);
		expect(isAssetFilePath(`Notebooks/_assets/${id(1)}.png`, "Notebooks")).toBe(true);
		expect(isAssetFilePath(`_assets/${id(1)}.jpeg`, "")).toBe(true);
		expect(isAssetFilePath("Notebooks/_assets/notes.pdf", "Notebooks")).toBe(false);
		expect(isAssetFilePath(`Notebooks/_assets/sub/${id(1)}.pdf`, "Notebooks")).toBe(false);
		expect(isAssetFilePath(`Notebooks/${id(1)}.pdf`, "Notebooks")).toBe(false);
		expect(isAssetFilePath(`Notebooks/Maths.notebook`, "Notebooks")).toBe(false);
		expect(isAssetFilePath(`Other/_assets/${id(1)}.pdf`, "Notebooks")).toBe(false);
		expect(assetsDir("")).toBe("_assets");
		expect(keptFolders({ root: "", backup: "_backup" })).toContain("_trash");
	});

	it("finds the asset ids a text could name", () => {
		expect(hexTokens(`{"id":"${id(7)}","x":1}`)).toEqual(new Set([id(7)]));
		expect(hexTokens("no ids here 1234")).toEqual(new Set());
		// a longer hex run (a full hash) still names its first 24 digits
		const long = `${id(8)}${"ab".repeat(8)}`;
		expect(hexTokens(`"${long}"`).has(id(8))).toBe(true);
	});
});

describe("one notebook's text", () => {
	it("reads a good notebook and collects the ids it names", () => {
		const r = scanNotebookText(notebookText(asset(1)), null);
		expect(r.status).toBe("ok");
		expect(r.tokens.has(id(1))).toBe(true);
	});

	it("an empty file, NUL bytes, or a file cut off is arriving, never damaged", () => {
		expect(scanNotebookText("", null).status).toBe("not-downloaded");
		expect(scanNotebookText("\0\0\0", null).status).toBe("not-downloaded");
		const text = notebookText(asset(1));
		expect(scanNotebookText(text.slice(0, text.length / 2), null).status).toBe("not-downloaded");
		expect(scanNotebookText(`${text}\0\0`, null).status).toBe("ok");
	});

	it("text that is not a notebook and not arriving is unreadable, but still protects what it names", () => {
		const r = scanNotebookText(`this is garbage ${id(5)} }}}`, 10 * 60_000);
		expect(r.status).toBe("unreadable");
		expect(r.tokens.has(id(5))).toBe(true);
	});

	it("a syntax error in a file that changed seconds ago is still being written", () => {
		expect(scanNotebookText("{ nope }", 2_000).status).toBe("not-downloaded");
		expect(scanNotebookText("{ nope }", 10 * 60_000).status).toBe("unreadable");
	});

	it("a newer format is reported apart, not as damage", () => {
		const text = notebookText().replace(/"version":\s*\d+/, '"version": 99');
		expect(scanNotebookText(text, null).status).toBe("future-version");
	});
});

describe("the library check", () => {
	it("an asset no notebook uses is an orphan; one a notebook uses is not", async () => {
		const src = vault()
			.put("Notebooks/Maths.notebook", { text: notebookText(asset(1)) })
			.put(...assetFile(1))
			.put(...assetFile(2));
		const r = await runLibraryCheck(src, config, opts(agedSeen(1, 2)));
		expect(r.complete).toBe(true);
		expect(r.orphans.map((o) => o.path)).toEqual([`Notebooks/_assets/${id(2)}.pdf`]);
		expect(r.orphanBytes).toBe(5000);
		expect(r.inUse).toEqual({ count: 1, bytes: 5000 });
		expect(r.assets).toEqual({ count: 2, bytes: 10_000 });
		expect(r.unreadable).toEqual([]);
	});

	it("a notebook anywhere in the vault protects its assets", async () => {
		const src = vault()
			.put("Elsewhere/Deep/Physics.notebook", { text: notebookText(asset(3)) })
			.put(...assetFile(3));
		expect((await runLibraryCheck(src, config, opts(agedSeen(3)))).orphans).toEqual([]);
	});

	it("an unreadable notebook is listed and protects what it names, but nothing is offered while it is there", async () => {
		const src = vault()
			.put("Notebooks/Broken.notebook", { text: `garbage that is not json ${id(4)}` })
			.put(...assetFile(4))
			.put(...assetFile(5));
		const r = await runLibraryCheck(src, config, opts(agedSeen(4, 5)));
		expect(r.unreadable.map((u) => u.path)).toEqual(["Notebooks/Broken.notebook"]);
		expect(r.inUse.count).toBe(1);
		expect(r.complete).toBe(false);
		expect(r.orphans).toEqual([]);
		expect(r.unjudged.count).toBe(1);
	});

	it("a notebook that is cut off in the middle (partly downloaded) makes the answer unsure", async () => {
		const text = notebookText(asset(1));
		const src = vault()
			.put("Notebooks/Half.notebook", { text: text.slice(0, text.length / 2) })
			.put(...assetFile(1))
			.put(...assetFile(2));
		const r = await runLibraryCheck(src, config, opts(agedSeen(1, 2)));
		expect(r.notDownloaded).toEqual(["Notebooks/Half.notebook"]);
		expect(r.complete).toBe(false);
		expect(r.orphans).toEqual([]);
	});

	it("an online-only or not downloaded notebook is never reported as unreadable, and no asset is called an orphan meanwhile", async () => {
		const src = vault()
			.put("Notebooks/Empty.notebook", { text: "", size: 0 })
			.put("Notebooks/OnlineOnly.notebook", { unreadable: true, size: 4000 })
			.put("Notebooks/Arriving.notebook", { text: "\0".repeat(50), size: 50 })
			.put("Notebooks/Good.notebook", { text: notebookText(asset(1)) })
			.put(...assetFile(1))
			.put(...assetFile(2));
		const r = await runLibraryCheck(src, config, opts(agedSeen(1, 2)));
		expect(r.unreadable).toEqual([]);
		expect(r.notDownloaded.sort()).toEqual(["Notebooks/Arriving.notebook", "Notebooks/Empty.notebook", "Notebooks/OnlineOnly.notebook"]);
		expect(r.complete).toBe(false);
		expect(r.orphans).toEqual([]);
		expect(r.orphanBytes).toBe(0);
		expect(r.unjudged).toEqual({ count: 1, bytes: 5000 });
		expect(r.unavailable).toBe(3);
	});

	it("an asset file with no content yet is waiting, never an orphan", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1, { size: 0 })).put(...assetFile(2));
		const r = await runLibraryCheck(src, config, opts(agedSeen(1, 2)));
		expect(r.waiting.count).toBe(1);
		expect(r.orphans.map((o) => o.id)).toEqual([id(2)]);
	});

	it("an asset file modified in the last hour is not judged", async () => {
		const src = vault()
			.put("Notebooks/Good.notebook", { text: notebookText() })
			.put(...assetFile(1, { mtime: NOW - 30 * 60_000 }))
			.put(...assetFile(2, { mtime: NOW - 2 * 3_600_000 }));
		const r = await runLibraryCheck(src, config, opts(agedSeen(1, 2)));
		expect(r.recent.count).toBe(1);
		expect(r.orphans.map((o) => o.id)).toEqual([id(2)]);
	});

	it("what backups, version history, the plugin trash, templates and stamps still use is kept, not offered", async () => {
		const src = vault()
			.put("Notebooks/Good.notebook", { text: notebookText() })
			.put("Notebooks/_backup/history/doc/20260101-1000.snapshot", { text: notebookText(asset(1)) })
			.put("Notebooks/_trash/items/abc/Old.notebook", { text: notebookText(asset(2)) })
			.put("Notebooks/_trash/pages/doc/entry.json", { text: JSON.stringify({ document: { assets: { [id(3)]: {} } } }) })
			.put("Notebooks/_templates/T.notebook", { text: notebookText(asset(4)) })
			.put("Notebooks/_stamps/s.stamp", { text: `{"image":"${id(5)}"}` })
			.put("Notebooks/_meta/pdf-links.json", { text: `{"pdf":"${id(6)}"}` });
		for (let n = 1; n <= 7; n++) src.put(...assetFile(n));
		const r = await runLibraryCheck(src, config, opts(agedSeen(1, 2, 3, 4, 5, 6, 7)));
		expect(r.kept.count).toBe(6);
		expect(r.orphans.map((o) => o.id)).toEqual([id(7)]);
		// trashed notebooks are not library notebooks
		expect(r.notebooks).toBe(1);
	});

	it("does not read backups and the trash when nothing is left to judge", async () => {
		const src = vault()
			.put("Notebooks/Good.notebook", { text: notebookText(asset(1)) })
			.put("Notebooks/_backup/history/doc/a.snapshot", { text: "x" })
			.put(...assetFile(1));
		await runLibraryCheck(src, config, opts(new MemSeen()));
		expect(src.reads).toEqual(["Notebooks/Good.notebook"]);
	});

	it("a backup that is not downloaded makes the answer unsure", async () => {
		const src = vault()
			.put("Notebooks/Good.notebook", { text: notebookText() })
			.put("Notebooks/_backup/history/doc/a.snapshot", { text: "", size: 0 })
			.put(...assetFile(1));
		const r = await runLibraryCheck(src, config, opts(agedSeen(1)));
		expect(r.complete).toBe(false);
		expect(r.orphans).toEqual([]);
		expect(r.unjudged.count).toBe(1);
	});

	it("a backup that is only partly downloaded (cut off, or ending in NUL bytes) makes the answer unsure, and still protects what it names", async () => {
		const text = notebookText(asset(1));
		for (const partial of [text.slice(0, Math.floor(text.length * 0.6)), `${text}\0\0\0`, `{"format": "x" garbage`]) {
			const src = vault()
				.put("Notebooks/Good.notebook", { text: notebookText() })
				.put("Notebooks/_backup/history/doc/a.snapshot", { text: partial })
				.put("Notebooks/_trash/items/abc/Old.json", { text: `{"copy":true}` })
				.put(...assetFile(1))
				.put(...assetFile(2));
			const r = await runLibraryCheck(src, config, opts(agedSeen(1, 2)));
			expect(r.complete).toBe(false);
			expect(r.orphans).toEqual([]);
			expect(r.unavailable).toBe(1);
		}
	});

	it("a complete backup JSON that does not name an asset is fine", async () => {
		const src = vault()
			.put("Notebooks/Good.notebook", { text: notebookText() })
			.put("Notebooks/_backup/history/doc/a.snapshot", { text: notebookText() })
			.put(...assetFile(1));
		const r = await runLibraryCheck(src, config, opts(agedSeen(1)));
		expect(r.complete).toBe(true);
		expect(r.orphans.map((o) => o.id)).toEqual([id(1)]);
	});

	it("only looks at files directly in the assets folder named like assets", async () => {
		const src = vault()
			.put("Notebooks/Good.notebook", { text: notebookText() })
			.put("Notebooks/_assets/readme.pdf", { size: 10 })
			.put(`Notebooks/_assets/sub/${id(9)}.pdf`, { size: 10 })
			.put(`Notebooks/Docs/${id(9)}.pdf`, { size: 10 })
			.put("Notebooks/Lecture slides.pdf", { size: 99 })
			.put(`Other/_assets/${id(9)}.pdf`, { size: 10 });
		const r = await runLibraryCheck(src, config, opts(agedSeen(9)));
		expect(r.assets.count).toBe(0);
		expect(r.orphans).toEqual([]);
	});

	it("the vault root works", async () => {
		const cfg: CheckConfig = { root: "", backup: "_backup", now: NOW };
		const src = vault().put("Maths.notebook", { text: notebookText(asset(1)) }).put(`_assets/${id(1)}.pdf`, { size: 10 }).put(`_assets/${id(2)}.pdf`, { size: 10 });
		expect((await runLibraryCheck(src, cfg, opts(agedSeen(1, 2)))).orphans.map((o) => o.id)).toEqual([id(2)]);
	});

	it("unchanged notebooks are not read again, a changed one is", async () => {
		const cache: ScanCache = new Map();
		const src = vault().put("Notebooks/A.notebook", { text: notebookText(asset(1)) }).put(...assetFile(1));
		await runLibraryCheck(src, config, opts(agedSeen(1), { cache }));
		await runLibraryCheck(src, config, opts(agedSeen(1), { cache }));
		expect(src.reads).toEqual(["Notebooks/A.notebook"]);
		src.put("Notebooks/A.notebook", { text: notebookText() });
		const r = await runLibraryCheck(src, config, opts(agedSeen(1), { cache }));
		expect(src.reads).toHaveLength(2);
		expect(r.orphans.map((o) => o.id)).toEqual([id(1)]);
	});

	it("a notebook that was still arriving is read again next time", async () => {
		const cache: ScanCache = new Map();
		const src = vault().put("Notebooks/A.notebook", { text: "\0\0", size: 2 }).put(...assetFile(1));
		const first = await runLibraryCheck(src, config, opts(agedSeen(1), { cache }));
		expect(first.complete).toBe(false);
		src.put("Notebooks/A.notebook", { text: notebookText(asset(1)), size: 3000 });
		const second = await runLibraryCheck(src, config, opts(agedSeen(1), { cache }));
		expect(second.complete).toBe(true);
		expect(second.orphans).toEqual([]);
	});

	it("can be cancelled", async () => {
		let stop = false;
		const src = vault().put("Notebooks/A.notebook", { text: notebookText() }).put("Notebooks/B.notebook", { text: notebookText() });
		const r = await runLibraryCheck(src, config, opts(new MemSeen(), { progress: () => { stop = true; }, cancelled: () => stop }));
		expect(r.cancelled).toBe(true);
		expect(r.orphans).toEqual([]);
		expect(r.complete).toBe(false);
	});

	it("reports progress for each notebook", async () => {
		const seen: Array<[number, number]> = [];
		const src = vault().put("Notebooks/A.notebook", { text: notebookText() }).put("Notebooks/B.notebook", { text: notebookText() });
		await runLibraryCheck(src, config, opts(new MemSeen(), { progress: (d, t) => seen.push([d, t]) }));
		expect(seen).toEqual([[1, 2], [2, 2]]);
	});

	it("this check's own record in _meta is not a reference", async () => {
		const src = vault()
			.put("Notebooks/Good.notebook", { text: notebookText() })
			.put("Notebooks/_meta/library-check-0a1b2c3d.json", { text: `{"seen":{"${id(1)}":1}}` })
			.put(...assetFile(1));
		const r = await runLibraryCheck(src, config, opts(agedSeen(1)));
		expect(r.kept.count).toBe(0);
		expect(r.orphans.map((o) => o.id)).toEqual([id(1)]);
	});

	it("device sidecars that cannot name assets, unsynced, empty or unreadable, do not make the answer incomplete", async () => {
		const sidecars = [
			"Notebooks/_meta/folders-0a1b2c3d.json", "Notebooks/_meta/library-0a1b2c3d.json", "Notebooks/_meta/library-check-0a1b2c3d.json",
			"Notebooks/_meta/folders.unreadable-deadbeef.json", "Notebooks/_meta/library.unreadable-deadbeef.json",
			"Notebooks/_meta/library-check.unreadable-deadbeef.json",
		];
		for (const state of [{ text: "", size: 0 }, { text: "{\"cut", size: 5 }, { unreadable: true, size: 50 }] as FakeFile[]) {
			const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
			for (const p of sidecars) src.put(p, state);
			const r = await runLibraryCheck(src, config, opts(agedSeen(1)));
			expect(r.complete).toBe(true);
			expect(r.unavailable).toBe(0);
			expect(r.orphans.map((o) => o.id)).toEqual([id(1)]);
			expect(src.reads.filter((p) => p.includes("/_meta/"))).toEqual([]);
		}
	});

	it("every other file that can name an asset stays a holder, in _meta too", async () => {
		expect(isNonHolderSidecar("Notebooks/_meta/folders-0a1b2c3d.json", "Notebooks")).toBe(true);
		expect(isNonHolderSidecar("_meta/library-0a1b2c3d.json", "")).toBe(true);
		for (const p of [
			"Notebooks/_meta/pdf-links-0a1b2c3d.json", "Notebooks/_meta/practice-0a1b2c3d.json", "Notebooks/_meta/page-moves-0a1b2c3d.json",
			"Notebooks/_meta/sub/folders-0a1b2c3d.json", "Notebooks/_trash/folders-0a1b2c3d.json", "Notebooks/_meta/folders-xyz.json",
			"Notebooks/_meta/practice.unreadable-deadbeef.json",
		]) expect(isNonHolderSidecar(p, "Notebooks"), p).toBe(false);
		// An unsynced holder (a page move record) still makes the answer unsure, and a complete one still protects.
		const unsure = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1))
			.put("Notebooks/_meta/page-moves-0a1b2c3d.json", { text: "", size: 0 });
		expect((await runLibraryCheck(unsure, config, opts(agedSeen(1)))).complete).toBe(false);
		const holds = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1))
			.put("Notebooks/_meta/practice-0a1b2c3d.json", { text: `{"a":"${id(1)}"}` });
		const r = await runLibraryCheck(holds, config, opts(agedSeen(1)));
		expect(r.kept.count).toBe(1);
		expect(r.orphans).toEqual([]);
	});
});

describe("how long a file has to be unused (a day on this device, not the file's own time)", () => {
	it("a picture that arrived before its notebook is not offered the first time, whatever its modification time says", async () => {
		// The file's mtime is days old (Drive and OneDrive keep the other device's time), but this device sees it for the first time.
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1, { mtime: OLD }));
		const seen = new MemSeen();
		const r = await runLibraryCheck(src, config, opts(seen));
		expect(r.complete).toBe(true);
		expect(r.orphans).toEqual([]);
		expect(r.recent.count).toBe(1);
		expect(seen.map?.get(id(1))).toBe(NOW);
	});

	it("is offered when an earlier check at least a day before also found it unused", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const seen = new MemSeen(new Map([[id(1), NOW - DAY]]));
		const r = await runLibraryCheck(src, config, opts(seen));
		expect(r.orphans.map((o) => o.id)).toEqual([id(1)]);
		// and not a minute earlier
		const young = new MemSeen(new Map([[id(1), NOW - DAY + 60_000]]));
		const r2 = await runLibraryCheck(src, config, opts(young));
		expect(r2.orphans).toEqual([]);
		expect(r2.recent.count).toBe(1);
		// the first sighting time is kept, not renewed
		expect(young.map?.get(id(1))).toBe(NOW - DAY + 60_000);
	});

	it("a file that was used in between starts again from nothing", async () => {
		const seen = new MemSeen(new Map([[id(1), NOW - 3 * DAY]]));
		const used = vault().put("Notebooks/Good.notebook", { text: notebookText(asset(1)) }).put(...assetFile(1));
		await runLibraryCheck(used, config, opts(seen));
		expect(seen.map?.has(id(1))).toBe(false);
		const unused = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const r = await runLibraryCheck(unused, config, opts(seen));
		expect(r.orphans).toEqual([]);
		expect(seen.map?.get(id(1))).toBe(NOW);
	});

	it("an asset an open notebook names is dropped from the record too", async () => {
		const seen = agedSeen(1);
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const r = await runLibraryCheck(src, config, opts(seen, { live: async () => ({ ids: [id(1)], incomplete: false }) }));
		expect(r.orphans).toEqual([]);
		expect(r.inUse.count).toBe(1);
		expect(seen.map?.has(id(1))).toBe(false);
	});

	it("without a record, or when the record cannot be read, nothing is offered and nothing is written", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const none = await runLibraryCheck(src, config, opts(undefined));
		expect(none.complete).toBe(true);
		expect(none.orphans).toEqual([]);
		const broken = new MemSeen(null);
		const r = await runLibraryCheck(src, config, opts(broken));
		expect(r.orphans).toEqual([]);
		expect(broken.saves).toBe(0);
		const throwing: SeenStore = { load: async () => { throw new Error("locked"); }, save: async () => undefined };
		expect((await runLibraryCheck(src, config, opts(throwing))).orphans).toEqual([]);
	});

	it("the record is written only by a complete check, and only when it changes", async () => {
		const seen = new MemSeen();
		const incomplete = vault().put("Notebooks/Late.notebook", { text: "", size: 0 }).put(...assetFile(1));
		await runLibraryCheck(incomplete, config, opts(seen));
		expect(seen.saves).toBe(0);
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1)).put(...assetFile(2, { size: 0 }));
		await runLibraryCheck(src, config, opts(seen));
		expect(seen.saves).toBe(1);
		// a file with no content yet is not recorded
		expect([...(seen.map?.keys() ?? [])]).toEqual([id(1)]);
		await runLibraryCheck(src, config, opts(seen));
		expect(seen.saves).toBe(1);
	});

	it("a failing save does not break the check", async () => {
		const seen: SeenStore = { load: async () => new Map(), save: async () => { throw new Error("disk full"); } };
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const r = await runLibraryCheck(src, config, opts(seen));
		expect(r.complete).toBe(true);
		expect(r.orphans).toEqual([]);
	});
});

describe("open notebooks and the journal", () => {
	it("an asset an open notebook or the journal names is in use", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1)).put(...assetFile(2)).put(...assetFile(3));
		const r = await runLibraryCheck(src, config, opts(agedSeen(1, 2, 3), { live: async () => ({ ids: new Set([id(1), id(2)]), incomplete: false }) }));
		expect(r.orphans.map((o) => o.id)).toEqual([id(3)]);
		expect(r.inUse.count).toBe(2);
	});

	it("when the open notebooks or the journal cannot be inspected the answer is incomplete and nothing is offered", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const cases: Array<RunOptions["live"]> = [
			async () => ({ ids: [], incomplete: true }),
			async () => { throw new Error("view broke"); },
			undefined,
		];
		for (const live of cases) {
			const r = await runLibraryCheck(src, config, { seen: agedSeen(1), ...(live ? { live } : {}) });
			expect(r.complete).toBe(false);
			expect(r.openIncomplete).toBe(true);
			expect(r.orphans).toEqual([]);
			expect(r.unjudged.count).toBe(1);
		}
	});
});

describe("moving unused files aside", () => {
	class Bin implements Mover {
		moved: Array<[string, string]> = [];
		fail = new Set<string>();
		async move(from: string, to: string): Promise<void> {
			if (this.fail.has(from)) throw new Error("locked");
			this.moved.push([from, to]);
		}
	}

	async function orphansOf(src: CheckSource, seen: SeenStore): Promise<AssetFile[]> {
		return (await runLibraryCheck(src, config, opts(seen))).orphans;
	}

	it("moves only the confirmed files, only the unused ones, into the recoverable folder", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText(asset(1)) }).put(...assetFile(1)).put(...assetFile(2)).put(...assetFile(3));
		const seen = agedSeen(1, 2, 3);
		const listed = await orphansOf(src, seen);
		expect(listed.map((o) => o.id).sort()).toEqual([id(2), id(3)]);
		const bin = new Bin();
		const r = await moveOrphans(src, config, listed.filter((o) => o.id === id(2)), bin, opts(seen));
		expect(bin.moved).toEqual([[`Notebooks/_assets/${id(2)}.pdf`, `Notebooks/_trash/assets/${id(2)}.pdf`]]);
		expect(r.moved).toHaveLength(1);
		expect(r.skipped).toEqual([]);
		expect(r.folder).toBe("Notebooks/_trash/assets");
		expect(assetTrashDir("")).toBe("_trash/assets");
	});

	it("a name already taken in the recoverable folder gets a number, never replaces", () => {
		const taken = new Set([`Notebooks/_trash/assets/${id(1)}.pdf`, `Notebooks/_trash/assets/${id(1)}-2.pdf`]);
		expect(assetTrashPath("Notebooks", { path: `Notebooks/_assets/${id(1)}.pdf` }, taken)).toBe(`Notebooks/_trash/assets/${id(1)}-3.pdf`);
		expect(assetTrashPath("Notebooks", { path: `Notebooks/_assets/${id(2)}.png` }, taken)).toBe(`Notebooks/_trash/assets/${id(2)}.png`);
	});

	it("runs the check again: a file that a notebook uses by now is left alone", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1)).put(...assetFile(2));
		const seen = agedSeen(1, 2);
		const listed = await orphansOf(src, seen);
		expect(listed).toHaveLength(2);
		// meanwhile a notebook is saved with a reference to asset 1
		src.put("Notebooks/Good.notebook", { text: notebookText(asset(1)), mtime: NOW });
		const bin = new Bin();
		const r = await moveOrphans(src, config, listed, bin, opts(seen, { cache: new Map() }));
		expect(bin.moved.map((m) => m[0])).toEqual([`Notebooks/_assets/${id(2)}.pdf`]);
		expect(r.skipped).toEqual([`Notebooks/_assets/${id(1)}.pdf`]);
	});

	it("asks the open notebooks again right before moving: a picture inserted since is left alone", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1)).put(...assetFile(2));
		const seen = agedSeen(1, 2);
		const listed = await orphansOf(src, seen);
		let calls = 0;
		// not open at first; by the time of the second question (right before moving) a view holds asset 1
		const live = async (): Promise<LiveReferences> => ({ ids: ++calls >= 2 ? [id(1)] : [], incomplete: false });
		const bin = new Bin();
		const r = await moveOrphans(src, config, listed, bin, opts(seen, { live }));
		expect(calls).toBe(2);
		expect(bin.moved.map((m) => m[0])).toEqual([`Notebooks/_assets/${id(2)}.pdf`]);
		expect(r.skipped).toEqual([`Notebooks/_assets/${id(1)}.pdf`]);
	});

	it("moves nothing when the open notebooks cannot be inspected at the last moment", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const seen = agedSeen(1);
		const listed = await orphansOf(src, seen);
		let calls = 0;
		const live = async (): Promise<LiveReferences> => ({ ids: [], incomplete: ++calls >= 2 });
		const bin = new Bin();
		const r = await moveOrphans(src, config, listed, bin, opts(seen, { live }));
		expect(r.incomplete).toBe(true);
		expect(bin.moved).toEqual([]);
	});

	it("a file that changed size since it was listed is left alone", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const seen = agedSeen(1);
		const listed = await orphansOf(src, seen);
		src.put(...assetFile(1, { size: 9999 }));
		const bin = new Bin();
		const r = await moveOrphans(src, config, listed, bin, opts(seen));
		expect(bin.moved).toEqual([]);
		expect(r.skipped).toHaveLength(1);
	});

	it("moves nothing when a file that could use an asset is not downloaded", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const seen = agedSeen(1);
		const listed = await orphansOf(src, seen);
		src.put("Notebooks/Late.notebook", { text: "", size: 0 });
		const bin = new Bin();
		const r = await moveOrphans(src, config, listed, bin, opts(seen));
		expect(r.incomplete).toBe(true);
		expect(bin.moved).toEqual([]);
	});

	it("moves nothing for a file that was not unused for a day, even if it is asked to", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const forged: AssetFile[] = [{ path: `Notebooks/_assets/${id(1)}.pdf`, id: id(1), size: 5000, mtime: OLD }];
		const bin = new Bin();
		const r = await moveOrphans(src, config, forged, bin, opts(new MemSeen()));
		expect(bin.moved).toEqual([]);
		expect(r.skipped).toHaveLength(1);
	});

	it("never moves a path that is not an asset file, whatever it is asked", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const bin = new Bin();
		const forged: AssetFile[] = [
			{ path: "Notebooks/Good.notebook", id: id(1), size: src.files().find((f) => f.path.endsWith("Good.notebook"))!.size, mtime: OLD },
			{ path: "Notebooks/_assets/notes.pdf", id: id(1), size: 5000, mtime: OLD },
		];
		const r = await moveOrphans(src, config, forged, bin, opts(agedSeen(1)));
		expect(bin.moved).toEqual([]);
		expect(r.skipped).toHaveLength(2);
	});

	it("reports files that could not be moved and goes on with the rest", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1)).put(...assetFile(2));
		const seen = agedSeen(1, 2);
		const listed = await orphansOf(src, seen);
		const bin = new Bin();
		bin.fail.add(`Notebooks/_assets/${id(1)}.pdf`);
		const r = await moveOrphans(src, config, listed, bin, opts(seen));
		expect(r.failed).toEqual([{ path: `Notebooks/_assets/${id(1)}.pdf`, error: "locked" }]);
		expect(bin.moved.map((m) => m[0])).toEqual([`Notebooks/_assets/${id(2)}.pdf`]);
	});

	it("has no way to delete: the mover only moves", () => {
		const bin: Mover = { move: async () => undefined };
		expect(Object.keys(bin)).toEqual(["move"]);
	});
});
