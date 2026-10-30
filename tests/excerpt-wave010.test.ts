/**
 * v10 anchored excerpts with the wave 0.10 features: the library check counts an excerpt's snapshot as used, the
 * cross-device clipboard and the lasso across pages carry the excerpt and its snapshot record.
 */
import { describe, expect, it } from "vitest";
import { captureCrossPageClip, planCrossPageTransform } from "../src/ink/cross-page";
import { layoutPages, PAGE_GAP } from "../src/ink/layout";
import { translate } from "../src/ink/transform";
import { makeSharedEntry, readSharedEntry } from "../src/ink/shared-clip";
import { captureClip } from "../src/ink/clipboard";
import { runLibraryCheck, type CheckSource, type VaultFileInfo } from "../src/library/library-check";
import { createDocument, createPage } from "../src/model/document";
import { createExcerpt } from "../src/model/excerpts";
import { History } from "../src/model/history";
import { serialize, serializeChecked } from "../src/model/serialize";
import type { Asset, ExcerptElement, NotebookDocument } from "../src/model/types";

const NOW = 1_000_000_000_000;
const OLD = NOW - 48 * 3_600_000;
const hex = (n: number) => n.toString(16).padStart(24, "0");
const snap = (n: number): Asset => ({ id: hex(n), kind: "image", path: `Notebooks/_assets/${hex(n)}.png`, name: "excerpt.png", bytes: 100 });

/** Two pages of 200 x 300; page 0 holds an excerpt of page 1 with snapshot `snap(1)`. */
function notebook(): { doc: NotebookDocument; excerpt: ExcerptElement } {
	const doc = createDocument(new Date("2026-10-30T10:00:00.000Z"), { width: 200, height: 300 });
	doc.pages.push(createPage({ width: 200, height: 300 }));
	doc.assets = { [snap(1).id]: snap(1) };
	const excerpt = createExcerpt(doc, "Notebooks/A.notebook", doc.pages[1]!, { x: 10, y: 10, width: 60, height: 40 }, { x: 20, y: 250, width: 60, height: 40 }, snap(1).id);
	doc.pages[0]!.elements = [excerpt];
	return { doc, excerpt };
}

class Source implements CheckSource {
	constructor(private readonly entries: Map<string, string>) {}
	files(): VaultFileInfo[] {
		return [...this.entries].map(([path, text]) => ({ path, size: text.length || 5000, mtime: OLD }));
	}
	async read(path: string): Promise<string> {
		return this.entries.get(path) ?? "";
	}
}

describe("anchored excerpts and the wave 0.10 features", () => {
	it("the library check counts an excerpt's snapshot as used (never an orphan)", async () => {
		const { doc } = notebook();
		const src = new Source(new Map([
			["Notebooks/A.notebook", serialize(doc)],
			[`Notebooks/_assets/${hex(1)}.png`, ""],
			[`Notebooks/_assets/${hex(2)}.png`, ""],
		]));
		const r = await runLibraryCheck(src, { root: "Notebooks", backup: "Notebooks/_backup", now: NOW });
		expect(r.complete).toBe(true);
		expect(r.orphans.map((o) => o.id)).toEqual([hex(2)]);
	});

	it("the cross-device clipboard carries the excerpt and its snapshot record", () => {
		const { doc } = notebook();
		const clip = captureClip([], doc.pages[0]!.elements!, doc.assets)!;
		const made = makeSharedEntry(clip, NOW);
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		expect(made.entry.images).toBe(1);
		const back = readSharedEntry(made.entry);
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		const e = back.clip.elements[0] as ExcerptElement;
		expect(e.type).toBe("excerpt");
		expect(e.source).toEqual(clip.elements[0]!.type === "excerpt" ? clip.elements[0]!.source : null);
		expect(e.asset).toBe(snap(1).id);
		expect(back.clip.assets.map((a) => a.id)).toEqual([snap(1).id]);
	});

	it("the lasso across pages copies and moves an excerpt (with its snapshot) to the page under it", () => {
		const { doc, excerpt } = notebook();
		const boxes = layoutPages(doc.pages).boxes;
		const parts = [{ pageIndex: 0, strokes: [], elements: [excerpt] }];
		const clip = captureCrossPageClip(boxes, doc.pages, parts, 0, doc.assets)!;
		expect(clip.assets.map((a) => a.id)).toEqual([snap(1).id]);
		const plan = planCrossPageTransform({ boxes, pages: doc.pages, primary: 0, parts, matrix: translate(0, 300 + PAGE_GAP) })!;
		const history = new History(() => doc);
		history.execute(plan.command);
		expect(plan.reparented).toBe(1);
		const moved = doc.pages[1]!.elements!.find((e) => e.id === excerpt.id) as ExcerptElement;
		expect(moved.source).toEqual(excerpt.source);
		expect(moved.asset).toBe(snap(1).id);
		expect(serializeChecked(doc).ok).toBe(true);
	});
});
