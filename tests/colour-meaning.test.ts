// 0.22 (#101) Colours with meaning: colour matching (tolerance, near duplicates), legend parsing, the filter, the regions
// and the digest Markdown, and the per-notebook sidecar (lenient reading, unknown fields kept, never overwriting a bad file).
import { describe, expect, it } from "vitest";
import { createPage, createStroke } from "../src/model/document";
import {
	MATCH_TOLERANCE, MEANING_END, MEANING_MAX, MEANING_START, TOLERANCES, buildMeaningSection, colourDistance, effectiveLegend, groupByMeaning,
	matchMeaning, meaningCounts, meaningRegions, nearDuplicates, nextFreeColour, parseLegend, replaceMeaningSection, strokeDimmer, withMeaning, withoutMeaning,
	type Meaning, type MeaningItem,
} from "../src/model/colour-meaning";
import { MEANINGS_PREFIX, applyMeaningOps, emptyMeanings, mergeMeaningFiles, overrideOf, parseMeanings, serializeMeanings, type MeaningsFile } from "../src/library/meanings";
import { MeaningsBlockedError, MeaningsStore } from "../src/library/meanings-store";
import type { DeviceFileAdapter } from "../src/storage/device-files";
import type { Page, Stroke } from "../src/model/types";

const RED = "#dc2626";
const BLUE = "#1d4ed8";
const legend: Meaning[] = [{ colour: RED, label: "Definition" }, { colour: BLUE, label: "Example" }];

function line(x0: number, x1: number, y: number, color: string, tool: Stroke["tool"] = "pen", width = 2): Stroke {
	const points: Array<[number, number, number]> = [];
	for (let x = x0; x <= x1; x += 5) points.push([x, y, 0.5]);
	return createStroke(color, width, points, tool);
}

function pageWith(...strokes: Stroke[]): Page {
	const p = createPage({ width: 600, height: 800 });
	p.strokes = strokes;
	return p;
}

describe("colour matching", () => {
	it("is zero for the same colour and large for opposites", () => {
		expect(colourDistance(RED, RED)).toBe(0);
		expect(colourDistance("#000000", "#ffffff")).toBeGreaterThan(0.9);
		expect(colourDistance(RED, "nonsense")).toBe(1);
	});

	it("matches the exact colour and a slightly different shade", () => {
		expect(matchMeaning(RED, legend)).toBe(0);
		expect(matchMeaning("#d92b2b", legend)).toBe(0);
		expect(matchMeaning("#2050d8", legend)).toBe(1);
	});

	it("does not match a clearly different colour", () => {
		expect(matchMeaning("#15803d", legend)).toBe(-1);
		expect(matchMeaning("#1e1e1e", legend)).toBe(-1);
	});

	it("respects the tolerance: a stricter one rejects what a looser one accepts", () => {
		const shade = "#c43a3a";
		const d = colourDistance(shade, RED);
		expect(d).toBeGreaterThan(TOLERANCES.strict);
		expect(matchMeaning(shade, legend, TOLERANCES.strict)).toBe(-1);
		expect(matchMeaning(shade, legend, Math.max(TOLERANCES.loose, d + 0.01))).toBe(0);
	});

	it("picks the nearest legend colour, and the earlier one on a tie", () => {
		const two: Meaning[] = [{ colour: "#ff0000", label: "A" }, { colour: "#ee1111", label: "B" }];
		expect(matchMeaning("#ee1111", two, 0.3)).toBe(1);
		const same: Meaning[] = [{ colour: "#ff0000", label: "A" }, { colour: "#ff0000", label: "B" }];
		expect(matchMeaning("#ff0000", same)).toBe(0);
	});

	it("finds near-duplicate legend colours", () => {
		const near: Meaning[] = [{ colour: RED, label: "Definition" }, { colour: "#d62828", label: "Theorem" }, { colour: BLUE, label: "Example" }];
		expect(nearDuplicates(near)).toEqual([[0, 1]]);
		expect(nearDuplicates(legend)).toEqual([]);
	});

	it("offers a free colour that is not close to a used one", () => {
		const free = nextFreeColour(legend, [RED, "#d92b2b", BLUE, "#15803d"]);
		expect(free).toBe("#15803d");
		expect(nextFreeColour([], ["#ABC"])).toBe("#aabbcc");
	});
});

describe("legend parsing", () => {
	it("reads a list leniently: normalises colours, trims labels, skips bad and repeated entries", () => {
		const out = parseLegend([
			{ colour: "#DC2626", label: "  Definition  " },
			{ colour: "1d4ed8", label: "Example" },
			{ colour: "#dc2626", label: "Again" },
			{ colour: "red", label: "Named" },
			{ colour: "#00ff00", label: "   " },
			{ colour: "#00ff00" },
			null,
			"x",
			{ colour: "#0f0", label: "Green", extra: 1 },
		]);
		expect(out).toEqual([{ colour: "#dc2626", label: "Definition" }, { colour: "#1d4ed8", label: "Example" }, { colour: "#00ff00", label: "Green" }]);
	});

	it("gives an empty legend for anything that is not a list", () => {
		for (const v of [undefined, null, 3, "x", {}, { colour: RED, label: "x" }]) expect(parseLegend(v)).toEqual([]);
	});

	it("limits the length and the label size", () => {
		const many = Array.from({ length: 40 }, (_, i) => ({ colour: `#${(i * 5 + 16).toString(16).padStart(2, "0")}0000`, label: "x".repeat(100) }));
		const out = parseLegend(many);
		expect(out).toHaveLength(MEANING_MAX);
		expect(out[0]!.label.length).toBeLessThanOrEqual(40);
	});

	it("edits a copy: replace, add, remove", () => {
		const a = withMeaning(legend, 0, { colour: "#ff00ff", label: "Rule" });
		expect(a[0]!.label).toBe("Rule");
		expect(legend[0]!.label).toBe("Definition");
		expect(withMeaning(legend, 5, { colour: "#00ff00", label: "New" })).toHaveLength(3);
		expect(withoutMeaning(legend, 0)).toEqual([legend[1]]);
	});

	it("uses the notebook's own legend when it has one, even an empty one", () => {
		expect(effectiveLegend(legend, null)).toBe(legend);
		expect(effectiveLegend(legend, [])).toEqual([]);
		expect(effectiveLegend(legend, [{ colour: "#00ff00", label: "x" }])).toHaveLength(1);
	});
});

describe("filter", () => {
	it("dims the ink of the other meanings and of no meaning, and nothing when no meaning is chosen", () => {
		const dim = strokeDimmer(legend, 0)!;
		expect(dim({ color: RED })).toBe(false);
		expect(dim({ color: "#d92b2b" })).toBe(false);
		expect(dim({ color: BLUE })).toBe(true);
		expect(dim({ color: "#1e1e1e" })).toBe(true);
		expect(strokeDimmer(legend, null)).toBeNull();
		expect(strokeDimmer(legend, 7)).toBeNull();
	});

	it("counts strokes per meaning, leaving hidden ink out", () => {
		const hidden = line(0, 50, 10, RED);
		hidden.hidden = true;
		const page = pageWith(line(0, 50, 100, RED), line(0, 50, 200, RED), line(0, 50, 300, BLUE), line(0, 50, 400, "#15803d"), hidden);
		expect(meaningCounts([page], legend)).toEqual({ perMeaning: [2, 1], none: 1 });
	});
});

describe("regions", () => {
	it("joins close ink of one meaning and keeps far ink apart", () => {
		const page = pageWith(line(50, 300, 100, RED), line(50, 280, 118, "#d92b2b"), line(50, 300, 500, RED));
		const regions = meaningRegions([page], legend);
		expect(regions).toHaveLength(2);
		expect(regions[0]!.strokeIds).toHaveLength(2);
		expect(regions[0]!.meaning).toBe(0);
		expect(regions[0]!.colour).toBe(RED);
	});

	it("keeps meanings apart even where their ink overlaps, and skips ink with no meaning, hidden ink and non-matching tools never", () => {
		const hidden = line(50, 300, 100, RED);
		hidden.hidden = true;
		const page = pageWith(line(50, 300, 100, RED), line(50, 300, 104, BLUE), line(50, 300, 108, "#15803d"), hidden, line(50, 300, 112, RED, "highlighter", 14));
		const regions = meaningRegions([page], legend);
		expect(regions.map((r) => r.meaning).sort()).toEqual([0, 1]);
		// the red pen line and the red highlighter are one place (same meaning, touching)
		expect(regions.find((r) => r.meaning === 0)!.strokeIds).toHaveLength(2);
	});

	it("is empty without a legend and orders places top to bottom per page", () => {
		const page = pageWith(line(50, 300, 400, BLUE), line(50, 300, 100, RED));
		expect(meaningRegions([page], [])).toEqual([]);
		expect(meaningRegions([page], legend).map((r) => r.rect.y)).toEqual([expect.any(Number), expect.any(Number)]);
		const ys = meaningRegions([page], legend).map((r) => r.rect.y);
		expect(ys[0]!).toBeLessThan(ys[1]!);
	});
});

describe("digest grouping and Markdown", () => {
	const pages = [pageWith(line(50, 300, 100, RED), line(50, 300, 400, BLUE)), pageWith(line(50, 300, 100, RED))];
	const regions = meaningRegions(pages, legend);
	const items: MeaningItem[] = regions.map((region, i) => ({ region, pageNumber: region.pageIndex + 1, image: `![[pic ${i}.png]]`, text: i === 0 ? "A quoted line" : "" }));
	const build = (its: readonly MeaningItem[], lg: readonly Meaning[] = legend) => buildMeaningSection({
		legend: lg, items: its, pageLink: (n, id) => `[[N#p${n}&id=${id}|Page ${n}]]`, intro: "intro", none: "none", emptyMeaning: "nothing", escape: (s) => s.replace(/#/g, "\\#"),
	});

	it("groups the places by meaning in legend order", () => {
		const by = groupByMeaning(items);
		expect([...by.keys()]).toEqual([0, 1]);
		expect(by.get(0)).toHaveLength(2);
		expect(by.get(1)).toHaveLength(1);
	});

	it("writes one section per meaning with the picture, the quote and the link to the page", () => {
		const text = build(items);
		expect(text.startsWith(MEANING_START)).toBe(true);
		expect(text.endsWith(MEANING_END)).toBe(true);
		expect(text.indexOf("## Definition")).toBeLessThan(text.indexOf("## Example"));
		expect(text).toContain("![[pic 0.png]]");
		expect(text).toContain("> A quoted line");
		expect(text).toContain("Page 2");
	});

	it("lists a meaning with no ink as empty, escapes labels and says when there is nothing", () => {
		const onlyRed = build(items.filter((i) => i.region.meaning === 0), [...legend, { colour: "#15803d", label: "C# rules" }]);
		expect(onlyRed).toContain("## Example\n\n*nothing*");
		expect(onlyRed).toContain("## C\\# rules");
		expect(build([])).toContain("none");
	});

	it("is deterministic: the same input gives the same text", () => {
		expect(build(items)).toBe(build(items));
	});

	it("replaces only what is between the markers and refuses an unpaired marker", () => {
		const section = build(items);
		const first = replaceMeaningSection("", section);
		expect(first.outcome).toBe("created");
		const edited = `my own text\n\n${first.text}\n\nafter`;
		const second = replaceMeaningSection(edited, build([]));
		expect(second.outcome).toBe("replaced");
		expect(second.text.startsWith("my own text")).toBe(true);
		expect(second.text.endsWith("after")).toBe(true);
		expect(replaceMeaningSection("text without markers", section).outcome).toBe("appended");
		const unsafe = `x ${MEANING_START} y`;
		expect(replaceMeaningSection(unsafe, section)).toEqual({ text: unsafe, outcome: "unsafe" });
	});

	it("has a default tolerance between strict and loose", () => {
		expect(TOLERANCES.strict).toBeLessThan(MATCH_TOLERANCE);
		expect(TOLERANCES.loose).toBeGreaterThan(MATCH_TOLERANCE);
	});
});

// ---------------------------------------------------------------------------------------------------- the sidecar

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

describe("per-notebook meanings sidecar", () => {
	const OWN = `Notebooks/_meta/${MEANINGS_PREFIX}-0a000000.json`;
	let clock = 1000;
	const make = (adapter = new MemoryAdapter(), device = "0a000000") => new MeaningsStore(adapter, () => "Notebooks", device, () => clock++);

	it("round-trips and keeps unknown entries and fields", () => {
		const text = JSON.stringify({
			format: "obsidian-notebook-meanings", version: 1, device: "0a000000",
			items: [{ scope: "nb1", legend: legend, at: 5, future: { a: 1 } }, { weird: true }],
		});
		const parsed = parseMeanings(text, "0a000000");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.data.unknown).toEqual([{ weird: true }]);
		const out = serializeMeanings(parsed.data);
		expect(out).toContain('"future":{"a":1}');
		expect(out).toContain('{"weird":true}');
		expect(parseMeanings(out, "0a000000").ok).toBe(true);
	});

	it("rejects a file that is empty, not ours, damaged or from the future without 'fixing' it", () => {
		expect(parseMeanings("  ", "0a000000")).toMatchObject({ ok: false, reason: "empty" });
		expect(parseMeanings("{", "0a000000")).toMatchObject({ ok: false, reason: "json" });
		expect(parseMeanings('{"format":"other","version":1,"items":[]}', "0a000000")).toMatchObject({ ok: false, reason: "format" });
		expect(parseMeanings('{"format":"obsidian-notebook-meanings","version":9,"items":[]}', "0a000000")).toMatchObject({ ok: false, reason: "future" });
	});

	it("the latest write wins across devices, a tie goes to the larger device; removing is a tombstone", () => {
		const a: MeaningsFile = { ...emptyMeanings("0a000000"), items: [{ scope: "nb1", legend, at: 10 }] };
		const b: MeaningsFile = { ...emptyMeanings("0b000000"), items: [{ scope: "nb1", legend: [{ colour: "#00ff00", label: "x" }], at: 10 }] };
		expect(mergeMeaningFiles([a, b]).get("nb1")!.legend[0]!.label).toBe("x");
		const removed = applyMeaningOps(a, mergeMeaningFiles([a]), [{ kind: "set", scope: "nb1", legend: null }], 20);
		expect(overrideOf(mergeMeaningFiles([removed]), "nb1")).toBeNull();
		expect(overrideOf(mergeMeaningFiles([a]), "nb1")).toEqual(legend);
	});

	it("writes only its own file and reads back what another device wrote", async () => {
		const adapter = new MemoryAdapter();
		const a = make(adapter);
		await a.set("nb1", legend);
		expect(adapter.writes).toEqual([OWN]);
		expect(a.get("nb1")).toEqual(legend);
		const b = make(adapter, "0b000000");
		await b.load();
		expect(b.get("nb1")).toEqual(legend);
		await b.set("nb1", null);
		expect(adapter.writes[adapter.writes.length - 1]).toBe("Notebooks/_meta/meanings-0b000000.json");
		expect(b.get("nb1")).toBeNull();
		await a.load();
		expect(a.get("nb1")).toBeNull();
	});

	it("never overwrites an own file it cannot read, keeps one copy of a damaged one", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set(OWN, "{not json");
		const store = make(adapter);
		await expect(store.set("nb1", legend)).rejects.toBeInstanceOf(MeaningsBlockedError);
		expect(adapter.files.get(OWN)).toBe("{not json");
		const copies = [...adapter.files.keys()].filter((k) => k.includes("unreadable"));
		expect(copies).toHaveLength(1);
		await expect(store.set("nb1", legend)).rejects.toBeInstanceOf(MeaningsBlockedError);
		expect([...adapter.files.keys()].filter((k) => k.includes("unreadable"))).toHaveLength(1);
	});

	it("leaves an empty (not yet synced) own file alone", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set(OWN, "");
		await expect(make(adapter).set("nb1", legend)).rejects.toBeInstanceOf(MeaningsBlockedError);
		expect(adapter.files.get(OWN)).toBe("");
	});

	it("skips another device's unreadable file and reports it", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set("Notebooks/_meta/meanings-0b000000.json", "garbage");
		const store = make(adapter);
		await store.set("nb1", legend);
		expect(store.blocked).toContain("meanings-0b000000.json");
		expect(store.get("nb1")).toEqual(legend);
		expect(adapter.files.get("Notebooks/_meta/meanings-0b000000.json")).toBe("garbage");
	});
});
