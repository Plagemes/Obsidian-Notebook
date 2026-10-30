import { describe, expect, it } from "vitest";
import {
	assetsDir, ASSET_GRACE_MS, hexTokens, isAssetFilePath, keptFolders, runLibraryCheck, scanNotebookText, trashOrphans,
	type AssetFile, type CheckConfig, type CheckSource, type ScanCache, type Trasher, type VaultFileInfo,
} from "../src/library/library-check";
import { serialize } from "../src/model/serialize";
import type { Asset } from "../src/model/types";
import { sampleDocument } from "./helpers";

const NOW = 1_000_000_000_000;
const OLD = NOW - 48 * 3_600_000;
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
		const r = await runLibraryCheck(src, config);
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
		expect((await runLibraryCheck(src, config)).orphans).toEqual([]);
	});

	it("an unreadable notebook is only reported, and still protects the assets it names", async () => {
		const src = vault()
			.put("Notebooks/Broken.notebook", { text: `garbage that is not json ${id(4)}` })
			.put(...assetFile(4))
			.put(...assetFile(5));
		const r = await runLibraryCheck(src, config);
		expect(r.unreadable.map((u) => u.path)).toEqual(["Notebooks/Broken.notebook"]);
		expect(r.complete).toBe(true);
		expect(r.orphans.map((o) => o.id)).toEqual([id(5)]);
	});

	it("an online-only or not downloaded notebook is never reported as unreadable, and no asset is called an orphan meanwhile", async () => {
		const src = vault()
			.put("Notebooks/Empty.notebook", { text: "", size: 0 })
			.put("Notebooks/OnlineOnly.notebook", { unreadable: true, size: 4000 })
			.put("Notebooks/Arriving.notebook", { text: "\0".repeat(50), size: 50 })
			.put("Notebooks/Good.notebook", { text: notebookText(asset(1)) })
			.put(...assetFile(1))
			.put(...assetFile(2));
		const r = await runLibraryCheck(src, config);
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
		const r = await runLibraryCheck(src, config);
		expect(r.waiting.count).toBe(1);
		expect(r.orphans.map((o) => o.id)).toEqual([id(2)]);
	});

	it("an asset file younger than the grace period is not judged", async () => {
		const src = vault()
			.put("Notebooks/Good.notebook", { text: notebookText() })
			.put(...assetFile(1, { mtime: NOW - ASSET_GRACE_MS + 1000 }))
			.put(...assetFile(2, { mtime: NOW - ASSET_GRACE_MS - 1000 }));
		const r = await runLibraryCheck(src, config);
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
		const r = await runLibraryCheck(src, config);
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
		await runLibraryCheck(src, config);
		expect(src.reads).toEqual(["Notebooks/Good.notebook"]);
	});

	it("a backup that is not downloaded makes the answer unsure", async () => {
		const src = vault()
			.put("Notebooks/Good.notebook", { text: notebookText() })
			.put("Notebooks/_backup/history/doc/a.snapshot", { text: "", size: 0 })
			.put(...assetFile(1));
		const r = await runLibraryCheck(src, config);
		expect(r.complete).toBe(false);
		expect(r.orphans).toEqual([]);
		expect(r.unjudged.count).toBe(1);
	});

	it("only looks at files directly in the assets folder named like assets", async () => {
		const src = vault()
			.put("Notebooks/Good.notebook", { text: notebookText() })
			.put("Notebooks/_assets/readme.pdf", { size: 10 })
			.put(`Notebooks/_assets/sub/${id(9)}.pdf`, { size: 10 })
			.put(`Notebooks/Docs/${id(9)}.pdf`, { size: 10 })
			.put("Notebooks/Lecture slides.pdf", { size: 99 })
			.put(`Other/_assets/${id(9)}.pdf`, { size: 10 });
		const r = await runLibraryCheck(src, config);
		expect(r.assets.count).toBe(0);
		expect(r.orphans).toEqual([]);
	});

	it("the vault root works", async () => {
		const cfg: CheckConfig = { root: "", backup: "_backup", now: NOW };
		const src = vault().put("Maths.notebook", { text: notebookText(asset(1)) }).put(`_assets/${id(1)}.pdf`, { size: 10 }).put(`_assets/${id(2)}.pdf`, { size: 10 });
		expect((await runLibraryCheck(src, cfg)).orphans.map((o) => o.id)).toEqual([id(2)]);
	});

	it("unchanged notebooks are not read again, a changed one is", async () => {
		const cache: ScanCache = new Map();
		const src = vault().put("Notebooks/A.notebook", { text: notebookText(asset(1)) }).put(...assetFile(1));
		await runLibraryCheck(src, config, { cache });
		await runLibraryCheck(src, config, { cache });
		expect(src.reads).toEqual(["Notebooks/A.notebook"]);
		src.put("Notebooks/A.notebook", { text: notebookText() });
		const r = await runLibraryCheck(src, config, { cache });
		expect(src.reads).toHaveLength(2);
		expect(r.orphans.map((o) => o.id)).toEqual([id(1)]);
	});

	it("a notebook that was still arriving is read again next time", async () => {
		const cache: ScanCache = new Map();
		const src = vault().put("Notebooks/A.notebook", { text: "\0\0", size: 2 }).put(...assetFile(1));
		const first = await runLibraryCheck(src, config, { cache });
		expect(first.complete).toBe(false);
		src.put("Notebooks/A.notebook", { text: notebookText(asset(1)), size: 3000 });
		const second = await runLibraryCheck(src, config, { cache });
		expect(second.complete).toBe(true);
		expect(second.orphans).toEqual([]);
	});

	it("can be cancelled", async () => {
		let stop = false;
		const src = vault().put("Notebooks/A.notebook", { text: notebookText() }).put("Notebooks/B.notebook", { text: notebookText() });
		const r = await runLibraryCheck(src, config, { progress: () => { stop = true; }, cancelled: () => stop });
		expect(r.cancelled).toBe(true);
		expect(r.orphans).toEqual([]);
		expect(r.complete).toBe(false);
	});

	it("reports progress for each notebook", async () => {
		const seen: Array<[number, number]> = [];
		const src = vault().put("Notebooks/A.notebook", { text: notebookText() }).put("Notebooks/B.notebook", { text: notebookText() });
		await runLibraryCheck(src, config, { progress: (d, t) => seen.push([d, t]) });
		expect(seen).toEqual([[1, 2], [2, 2]]);
	});
});

describe("moving unused files to the trash", () => {
	class Bin implements Trasher {
		moved: string[] = [];
		fail = new Set<string>();
		async trash(path: string): Promise<void> {
			if (this.fail.has(path)) throw new Error("locked");
			this.moved.push(path);
		}
	}

	async function orphansOf(src: CheckSource): Promise<AssetFile[]> {
		return (await runLibraryCheck(src, config)).orphans;
	}

	it("moves only the confirmed files, only the unused ones", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText(asset(1)) }).put(...assetFile(1)).put(...assetFile(2)).put(...assetFile(3));
		const listed = await orphansOf(src);
		expect(listed.map((o) => o.id).sort()).toEqual([id(2), id(3)]);
		const bin = new Bin();
		const r = await trashOrphans(src, config, listed.filter((o) => o.id === id(2)), bin);
		expect(bin.moved).toEqual([`Notebooks/_assets/${id(2)}.pdf`]);
		expect(r.moved).toHaveLength(1);
		expect(r.skipped).toEqual([]);
	});

	it("runs the check again: a file that a notebook uses by now is left alone", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1)).put(...assetFile(2));
		const listed = await orphansOf(src);
		expect(listed).toHaveLength(2);
		// meanwhile a notebook is saved with a reference to asset 1
		src.put("Notebooks/Good.notebook", { text: notebookText(asset(1)), mtime: NOW });
		const bin = new Bin();
		const r = await trashOrphans(src, config, listed, bin, { cache: new Map() });
		expect(bin.moved).toEqual([`Notebooks/_assets/${id(2)}.pdf`]);
		expect(r.skipped).toEqual([`Notebooks/_assets/${id(1)}.pdf`]);
	});

	it("a file that changed size since it was listed is left alone", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const listed = await orphansOf(src);
		src.put(...assetFile(1, { size: 9999 }));
		const bin = new Bin();
		const r = await trashOrphans(src, config, listed, bin);
		expect(bin.moved).toEqual([]);
		expect(r.skipped).toHaveLength(1);
	});

	it("moves nothing when a file that could use an asset is not downloaded", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const listed = await orphansOf(src);
		src.put("Notebooks/Late.notebook", { text: "", size: 0 });
		const bin = new Bin();
		const r = await trashOrphans(src, config, listed, bin);
		expect(r.incomplete).toBe(true);
		expect(bin.moved).toEqual([]);
	});

	it("never moves a path that is not an asset file, whatever it is asked", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1));
		const bin = new Bin();
		const forged: AssetFile[] = [
			{ path: "Notebooks/Good.notebook", id: id(1), size: src.files().find((f) => f.path.endsWith("Good.notebook"))!.size, mtime: OLD },
			{ path: "Notebooks/_assets/notes.pdf", id: id(1), size: 5000, mtime: OLD },
		];
		const r = await trashOrphans(src, config, forged, bin);
		expect(bin.moved).toEqual([]);
		expect(r.skipped).toHaveLength(2);
	});

	it("reports files that could not be moved and goes on with the rest", async () => {
		const src = vault().put("Notebooks/Good.notebook", { text: notebookText() }).put(...assetFile(1)).put(...assetFile(2));
		const listed = await orphansOf(src);
		const bin = new Bin();
		bin.fail.add(`Notebooks/_assets/${id(1)}.pdf`);
		const r = await trashOrphans(src, config, listed, bin);
		expect(r.failed).toEqual([{ path: `Notebooks/_assets/${id(1)}.pdf`, error: "locked" }]);
		expect(bin.moved).toEqual([`Notebooks/_assets/${id(2)}.pdf`]);
	});

	it("has no way to delete: the trasher is the only thing it can call", () => {
		const bin: Trasher = { trash: async () => undefined };
		expect(Object.keys(bin)).toEqual(["trash"]);
	});
});
