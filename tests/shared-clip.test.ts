import { describe, expect, it } from "vitest";
import { captureClip, instantiateClip } from "../src/ink/clipboard";
import {
	addSharedEntry, listSharedItems, makeSharedEntry, MAX_SHARED_ENTRIES, parseSharedClip, readSharedEntry, serializeSharedClip,
	SHARED_CLIP_FORMAT, type SharedClipEntry,
} from "../src/ink/shared-clip";
import { createId } from "../src/model/document";
import { createEquation, createGraph } from "../src/model/math-elements";
import { BOUND_SEPARATOR, boundGraphId } from "../src/ink/attach";
import type { Asset, ImageElement, TextElement } from "../src/model/types";
import type { DeviceFileAdapter } from "../src/storage/device-files";
import { SharedClipBlockedError, SharedClipRefusedError, SharedClipStore } from "../src/storage/shared-clip-store";
import { line } from "./helpers";

const asset: Asset = { id: "a".repeat(24), kind: "image", path: "Notebooks/_assets/aaaaaaaaaaaaaaaaaaaaaaaa.png", name: "photo.png", bytes: 1234 };
const image: ImageElement = { id: createId(), type: "image", asset: asset.id, x: 100, y: 120, width: 80, height: 60, rotation: 0 };
const note: TextElement = { id: createId(), type: "text", x: 20, y: 30, width: 120, text: "hello", fontSize: 14, color: "#1e1e1e" };

function clip(strokes = 2, withImage = true) {
	const s = Array.from({ length: strokes }, (_, i) => line(10, 10 + i * 10, 200, 20 + i * 10));
	return captureClip(s, withImage ? [image, note] : [note], { [asset.id]: asset })!;
}

class MemoryAdapter implements DeviceFileAdapter {
	files = new Map<string, string>();
	folders = new Set<string>();
	writes: string[] = [];
	async exists(p: string) { return this.files.has(p) || this.folders.has(p); }
	async read(p: string) {
		const v = this.files.get(p);
		if (v === undefined) throw new Error("ENOENT");
		return v;
	}
	async write(p: string, d: string) { this.files.set(p, d); this.writes.push(p); }
	async mkdir(p: string) { this.folders.add(p); }
	async list(folder: string) { return [...this.files.keys()].filter((k) => k.startsWith(`${folder}/`) && !k.slice(folder.length + 1).includes("/")); }
}

const OWN = "Notebooks/_meta/clipboard-aaaaaaaa.json";
const OTHER = "Notebooks/_meta/clipboard-bbbbbbbb.json";

describe("shared clipboard entries", () => {
	it("round-trips strokes, text boxes and the picture records, and pastes with fresh ids", () => {
		const made = makeSharedEntry(clip(), 1_700_000_000_000);
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		expect(made.entry).toMatchObject({ at: 1_700_000_000_000, strokes: 2, images: 1, texts: 1 });
		const read = readSharedEntry(made.entry);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.clip.strokes).toHaveLength(2);
		expect(read.clip.elements.map((e) => e.type).sort()).toEqual(["image", "text"]);
		expect(read.clip.assets).toEqual([asset]);
		const pasted = instantiateClip(read.clip, 10, 10);
		expect(pasted.strokes.every((s) => !read.clip.strokes.some((o) => o.id === s.id))).toBe(true);
		expect(pasted.elements.every((e) => e.id !== image.id && e.id !== note.id)).toBe(true);
		// The picture keeps its asset id: the file is already in the vault's assets folder.
		expect(pasted.elements.find((e) => e.type === "image")).toMatchObject({ asset: asset.id });
	});

	it("refuses a selection that is too big to share", () => {
		const huge = captureClip([line(0, 0, 30_000, 10)], [], undefined)!;
		const made = makeSharedEntry(huge, 1);
		expect(made.ok).toBe(false);
		if (!made.ok) expect(made.reason).toBe("too-large");
	});
});

describe("clipboard file", () => {
	const entry = (at: number, text = "x"): SharedClipEntry => ({ id: createId(), at, strokes: 1, images: 0, texts: 0, text });

	it("parses what it wrote and keeps entries it does not understand", () => {
		const raw = JSON.stringify({ format: SHARED_CLIP_FORMAT, version: 1, entries: [entry(5), { id: "future", shape: "unknown" }, 42] });
		const parsed = parseSharedClip(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.data.entries).toHaveLength(1);
		expect(parsed.data.unknown).toHaveLength(2);
		const again = parseSharedClip(serializeSharedClip(parsed.data));
		expect(again.ok && again.data.unknown).toEqual(parsed.data.unknown);
	});

	it("says why a file cannot be read", () => {
		expect(parseSharedClip("")).toMatchObject({ ok: false, reason: "empty" });
		expect(parseSharedClip("  \n")).toMatchObject({ ok: false, reason: "empty" });
		expect(parseSharedClip("{nope")).toMatchObject({ ok: false, reason: "json" });
		expect(parseSharedClip(JSON.stringify({ hello: 1 }))).toMatchObject({ ok: false, reason: "format" });
		expect(parseSharedClip(JSON.stringify({ format: SHARED_CLIP_FORMAT, version: 9, entries: [] }))).toMatchObject({ ok: false, reason: "future" });
	});

	it("keeps the newest entries and drops the oldest", () => {
		let data = { entries: [] as SharedClipEntry[], unknown: [] as unknown[] };
		for (let i = 0; i < MAX_SHARED_ENTRIES + 2; i++) {
			const added = addSharedEntry(data, entry(i));
			expect(added.ok).toBe(true);
			if (added.ok) data = added.data;
		}
		expect(data.entries).toHaveLength(MAX_SHARED_ENTRIES);
		expect(data.entries.map((e) => e.at)).toEqual([6, 5, 4, 3, 2]);
	});

	it("drops older entries to stay within the size cap and refuses an entry that does not fit alone", () => {
		const big = (at: number) => entry(at, "y".repeat(400));
		let data = { entries: [big(1), big(2)], unknown: [] as unknown[] };
		const added = addSharedEntry(data, big(3), 1_200);
		expect(added.ok).toBe(true);
		if (added.ok) {
			expect(added.data.entries[0]!.at).toBe(3);
			expect(added.data.entries.length).toBeLessThan(3);
			expect(serializeSharedClip(added.data).length).toBeLessThanOrEqual(1_200);
			data = added.data;
		}
		const refused = addSharedEntry(data, entry(9, "z".repeat(5_000)), 1_200);
		expect(refused.ok).toBe(false);
	});

	it("lists other devices' entries newest first with a limit", () => {
		const items = listSharedItems([
			{ device: "bbbbbbbb", data: { entries: [entry(10), entry(30)], unknown: [] } },
			{ device: "cccccccc", data: { entries: [entry(20)], unknown: [] } },
		], 2);
		expect(items.map((i) => [i.device, i.entry.at])).toEqual([["bbbbbbbb", 30], ["cccccccc", 20]]);
	});
});

describe("clipboard store (one file per device)", () => {
	it("a missing file is created by the first copy, in the device's own file only", async () => {
		const ad = new MemoryAdapter();
		const store = new SharedClipStore(ad, () => "Notebooks", "aaaaaaaa");
		expect(store.ownPath).toBe(OWN);
		expect((await store.listOthers()).items).toEqual([]);
		expect(ad.writes).toEqual([]);
		const result = await store.publish(clip(), 1000);
		expect(result).toEqual({ entries: 1, dropped: 0 });
		expect(ad.writes).toEqual([OWN]);
		expect(ad.folders.has("Notebooks/_meta")).toBe(true);
		const parsed = parseSharedClip(ad.files.get(OWN)!);
		expect(parsed.ok && parsed.data.entries[0]!.at).toBe(1000);
	});

	it("another device lists the entries, newest first, and never its own", async () => {
		const ad = new MemoryAdapter();
		const tablet = new SharedClipStore(ad, () => "Notebooks", "bbbbbbbb");
		const phone = new SharedClipStore(ad, () => "Notebooks", "aaaaaaaa");
		await tablet.publish(clip(1), 1000);
		await tablet.publish(clip(3), 2000);
		await phone.publish(clip(2), 3000);
		const seen = await phone.listOthers();
		expect(seen.unreadable).toEqual([]);
		expect(seen.items.map((i) => [i.device, i.entry.at, i.entry.strokes])).toEqual([["bbbbbbbb", 2000, 3], ["bbbbbbbb", 1000, 1]]);
		const back = readSharedEntry(seen.items[0]!.entry);
		expect(back.ok && back.clip.strokes.length).toBe(3);
		// Listing wrote nothing.
		expect(ad.writes).toEqual([OTHER, OTHER, OWN]);
	});

	it("never overwrites an own file it cannot read: one copy is kept, nothing is written", async () => {
		const ad = new MemoryAdapter();
		ad.files.set(OWN, "{ this is not json");
		const store = new SharedClipStore(ad, () => "Notebooks", "aaaaaaaa");
		await expect(store.publish(clip(), 1)).rejects.toBeInstanceOf(SharedClipBlockedError);
		expect(ad.files.get(OWN)).toBe("{ this is not json");
		expect(ad.writes.filter((w) => w === OWN)).toEqual([]);
		expect([...ad.files.keys()].some((k) => k.includes("unreadable"))).toBe(true);
	});

	it("never overwrites an empty own file (it may not have synced yet) or one from a newer version", async () => {
		const ad = new MemoryAdapter();
		const store = new SharedClipStore(ad, () => "Notebooks", "aaaaaaaa");
		ad.files.set(OWN, "");
		await expect(store.publish(clip(), 1)).rejects.toMatchObject({ reason: "empty" });
		expect(ad.files.get(OWN)).toBe("");
		const future = JSON.stringify({ format: SHARED_CLIP_FORMAT, version: 99, entries: [] });
		ad.files.set(OWN, future);
		await expect(store.publish(clip(), 1)).rejects.toMatchObject({ reason: "future" });
		expect(ad.files.get(OWN)).toBe(future);
	});

	it("refuses a selection that is too large without touching the file", async () => {
		const ad = new MemoryAdapter();
		const store = new SharedClipStore(ad, () => "Notebooks", "aaaaaaaa");
		const huge = captureClip([line(0, 0, 30_000, 10)], [], undefined)!;
		await expect(store.publish(huge, 1)).rejects.toBeInstanceOf(SharedClipRefusedError);
		expect(ad.writes).toEqual([]);
	});

	it("skips unreadable files of other devices and reports them", async () => {
		const ad = new MemoryAdapter();
		ad.files.set(OTHER, "garbage");
		ad.files.set("Notebooks/_meta/clipboard-cccccccc.json", "");
		const store = new SharedClipStore(ad, () => "Notebooks", "aaaaaaaa");
		const seen = await store.listOthers();
		expect(seen.items).toEqual([]);
		expect(seen.unreadable).toHaveLength(2);
		expect(ad.files.get(OTHER)).toBe("garbage");
		expect(ad.writes).toEqual([]);
	});

	it("keeps the entries an own file already has when a new copy is added", async () => {
		const ad = new MemoryAdapter();
		const store = new SharedClipStore(ad, () => "Notebooks", "aaaaaaaa");
		await store.publish(clip(1), 1);
		await store.publish(clip(2), 2);
		const parsed = parseSharedClip(ad.files.get(OWN)!);
		expect(parsed.ok && parsed.data.entries.map((e) => e.at)).toEqual([2, 1]);
	});
});

describe("shared clipboard with equations and graphs (format v9)", () => {
	it("round-trips an equation and a graph with its bound ink through the strict validation", () => {
		const eq = createEquation(30, 40, "x^2+1", 14, "#1e1e1e", { numbered: true, width: 60, height: 20 });
		const graph = createGraph(40, 100, 200, 120);
		const bound = { ...line(60, 120, 180, 180), id: `${graph.id}${BOUND_SEPARATOR}${createId()}` };
		const made = makeSharedEntry(captureClip([bound], [eq, graph], undefined)!, 5);
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		expect(made.entry).toMatchObject({ strokes: 1, images: 0, texts: 2 });
		const read = readSharedEntry(made.entry);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.clip.elements.map((e) => e.type).sort()).toEqual(["equation", "graph"]);
		const readGraph = read.clip.elements.find((e) => e.type === "graph")!;
		const readEq = read.clip.elements.find((e) => e.type === "equation");
		expect(readEq).toMatchObject({ latex: "x^2+1", numbered: true });
		// The ink keeps the id that binds it to its graph, and the graph keeps its id, inside the entry.
		expect(boundGraphId(read.clip.strokes[0]!)).toBe(readGraph.id);
		// Pasting gives new ids, and the copied ink is bound to the copied graph (not to the original).
		const pasted = instantiateClip(read.clip, 10, 10);
		expect(pasted.elements.map((e) => e.type).sort()).toEqual(["equation", "graph"]);
		const pastedGraph = pasted.elements.find((e) => e.type === "graph")!;
		expect(boundGraphId(pasted.strokes[0]!)).toBe(pastedGraph.id);
		expect(pasted.strokes[0]!.id).not.toBe(read.clip.strokes[0]!.id);
		expect(pasted.elements.every((e) => e.id !== eq.id && e.id !== graph.id)).toBe(true);
	});

	it("goes through the store like any other copy", async () => {
		const ad = new MemoryAdapter();
		const me = new SharedClipStore(ad, () => "Notebooks", "aaaaaaaa");
		await me.publish(captureClip([], [createEquation(0, 0, "a+b", 12, "#000000", { width: 40, height: 16 }), createGraph(0, 30, 100, 80)], undefined)!, 3);
		const other = new SharedClipStore(ad, () => "Notebooks", "bbbbbbbb");
		const seen = await other.listOthers();
		expect(seen.items).toHaveLength(1);
		const read = readSharedEntry(seen.items[0]!.entry);
		expect(read.ok && read.clip.elements.map((e) => e.type).sort()).toEqual(["equation", "graph"]);
	});
});

describe("age of a copy", () => {
	it("picks the unit", async () => {
		const { clipAge } = await import("../src/ink/shared-clip");
		const now = 10_000_000_000;
		expect(clipAge(now, now - 20_000)).toEqual({ unit: "now", n: 0 });
		expect(clipAge(now, now - 5 * 60_000)).toEqual({ unit: "minutes", n: 5 });
		expect(clipAge(now, now - 3 * 3_600_000)).toEqual({ unit: "hours", n: 3 });
		expect(clipAge(now, now - 3 * 86_400_000)).toEqual({ unit: "days", n: 3 });
		expect(clipAge(now, now + 60_000)).toEqual({ unit: "now", n: 0 });
	});
});
