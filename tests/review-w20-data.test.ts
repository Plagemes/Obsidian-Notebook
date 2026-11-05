/** 0.20 review fixes (data safety and hot paths, K-planner, K-dropfiles). Pure logic only. */
import { describe, expect, it, vi } from "vitest";
import { pagesToPdf } from "../src/ink/export-pdf";
import { pageToSvg } from "../src/ink/export-svg";
import { hitLink, linkRects, soleLink } from "../src/ink/link-text";
import { drawTextElement } from "../src/ink/renderer";
import { layoutText, textElementBounds } from "../src/ink/text-layout";
import { linkLabel, shownText } from "../src/ink/wikilink";
import { createPage } from "../src/model/document";
import { planDiffRestore, planDiffRestoreInto } from "../src/model/diff-restore";
import { choosePicturePath, MAX_HEADING_NOTEBOOKS, MAX_PICTURE_NAMES, NotebookLru, numberedName, PICTURE_MARK, type PictureProbe } from "../src/model/companion-pictures";
import { ghostTouchRedraws, GHOST_IDLE_MS } from "../src/model/ghost-lines";
import { buildPlanner, type PlannerOptions } from "../src/model/planner";
import { addPngText, crc32, readPngText } from "../src/model/png-text";
import { MAX_SHARE_RANGE_CHARS, shareFileNames, shareSuffix } from "../src/model/share-page";
import { PAGE_SIZES, type Page, type TextElement } from "../src/model/types";
import { isInboxCandidate, type InboxContext } from "../src/library/shared-inbox-logic";
import { createdNotebookName } from "../src/storage/names";
import { commitWithFiles } from "../src/view/drop-files-logic";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

const box = (text: string, over: Partial<TextElement> = {}): TextElement => ({ id: "t", type: "text", x: 50, y: 100, width: 600, text, fontSize: 10, color: "#111111", ...over });
const mono = (s: string, fs: number) => Array.from(s).length * fs;

// ------------------------------------------------------------------------------------------------------- K-planner

describe("K-planner: a link shows its label, not its markup", () => {
	const PLANNER = "[[Planner 2026.notebook#p14&id=d71|Mar]]";

	it("shows the alias of a page link", () => {
		const shown = shownText(PLANNER);
		expect(shown.text).toBe("Mar");
		expect(shown.links).toHaveLength(1);
		expect(shown.links[0]).toMatchObject({ start: 0, end: 3, target: "Planner 2026.notebook", subpath: "p14&id=d71", alias: "Mar" });
	});

	it("shows a short name when there is no alias", () => {
		expect(linkLabel({ target: "Folder/Physics.md", subpath: "", alias: null })).toBe("Physics");
		expect(linkLabel({ target: "Planner 2026.notebook", subpath: "p14&id=d71", alias: null })).toBe("Planner 2026 p. 14");
		expect(linkLabel({ target: "Planner 2026.notebook", subpath: "p3", alias: null })).toBe("Planner 2026 p. 3");
		expect(linkLabel({ target: "Note", subpath: "Heading", alias: null })).toBe("Note › Heading");
		expect(linkLabel({ target: "Note", subpath: "^abc123", alias: null })).toBe("Note");
		expect(linkLabel({ target: "v1.2 plan", subpath: "", alias: null })).toBe("v1.2 plan");
		expect(linkLabel({ target: "A", subpath: "", alias: "the alias" })).toBe("the alias");
	});

	it("replaces every link in a longer text and keeps the offsets right", () => {
		const shown = shownText("see [[Notes/Physics.md]] and [[Maths|M]] now\r\nsecond [[Chem#p2]]");
		expect(shown.text).toBe("see Physics and M now\nsecond Chem p. 2");
		for (const l of shown.links) expect(shown.text.slice(l.start, l.end)).toBe(linkLabel(l));
		expect(shown.links.map((l) => l.target)).toEqual(["Notes/Physics.md", "Maths", "Chem"]);
	});

	it("leaves text without links, embeds and half-typed links as they are", () => {
		for (const text of ["plain", "![[pic.png]]", "[[unfinished", "a [[ ]] b", "[[|x]]"]) expect(shownText(text).text).toBe(text);
		expect(shownText("![[pic.png]] [[A]]").text).toBe("![[pic.png]] A");
	});

	it("sizes the box from what is shown, not from the markup", () => {
		const el = box(PLANNER, { width: 300 });
		expect(textElementBounds(el, mono).maxY - el.y).toBeCloseTo(12.5);
		const raw = layoutText(PLANNER, 10, 100, (s) => mono(s, 10));
		expect(raw.lines.length).toBeGreaterThan(1); // the markup alone would have wrapped
		expect(textElementBounds(box(PLANNER, { width: 100 }), mono).maxY - 100).toBeCloseTo(12.5);
	});

	it("keeps the tap area on the link: a lone link by its whole box, others by their label", () => {
		const lone = box(PLANNER, { width: 200 });
		expect(soleLink(lone.text)?.subpath).toBe("p14&id=d71");
		expect(hitLink([lone], 100, 105, 0, mono)).toMatchObject({ whole: true });
		const mixed = box("go to [[Physics|Phys]] today");
		const [rect] = linkRects(mixed, mono);
		expect(rect).toMatchObject({ x: 50 + 6 * 10, width: 4 * 10 });
		expect(hitLink([mixed], 50 + 7 * 10, 105, 0, mono)?.link.target).toBe("Physics");
		expect(hitLink([mixed], 50 + 12 * 10, 105, 0, mono)).toBeNull(); // where the markup used to be
	});

	it("draws the label in the link colour with an underline, never the brackets", () => {
		const drawn: Array<{ text: string; fill: string }> = [];
		let fill = "";
		let strokes = 0;
		const ctx = {
			save: () => undefined, restore: () => undefined, beginPath: () => undefined, moveTo: () => undefined, lineTo: () => undefined,
			setLineDash: () => undefined, fillRect: () => undefined, arc: () => undefined, fill: () => undefined,
			stroke: () => { strokes++; },
			measureText: (s: string) => ({ width: Array.from(s).length * 5 }),
			fillText: (text: string) => { drawn.push({ text, fill }); },
			set fillStyle(v: string) { fill = v; }, get fillStyle() { return fill; },
			font: "", textBaseline: "", strokeStyle: "", lineWidth: 0, lineCap: "", lineJoin: "", globalAlpha: 1,
		} as unknown as CanvasRenderingContext2D;
		drawTextElement(ctx, box("open [[Planner 2026.notebook#p14&id=d71|March]] now"));
		expect(drawn.map((d) => d.text).join("")).toBe("open March now");
		expect(drawn.find((d) => d.text === "March")?.fill).toBe("#2563eb");
		expect(drawn.find((d) => d.text === "open ")?.fill).toBe("#111111");
		expect(strokes).toBeGreaterThan(0);
	});

	const page = (el: TextElement): Page => ({ ...createPage(), elements: [el] });

	it("shows the label, styled as a link, in the vector exports", () => {
		const el = box("open [[Planner 2026.notebook#p14&id=d71|March]] now", { width: 400 });
		const svg = pageToSvg(page(el));
		expect(svg).toContain(">March</tspan>");
		expect(svg).toContain('fill="#2563eb"');
		expect(svg).not.toContain("Planner 2026.notebook");
		expect(svg).not.toContain("[[");
		const pdf = new TextDecoder("latin1").decode(pagesToPdf([page(el)]));
		expect(pdf).toContain("(March) Tj");
		expect(pdf).not.toContain("Planner 2026");
		expect(pdf).toContain("0.145 0.388 0.922 rg"); // the link colour
	});

	it("exports plain text exactly as before", () => {
		const pdf = new TextDecoder("latin1").decode(pagesToPdf([page(box("hello world", { width: 400 }))]));
		expect(pdf).toContain("(hello world) Tj");
	});

	it("builds the planner with page links that show a short label", () => {
		let n = 0;
		const o: PlannerOptions = {
			year: 2026, startMonth: 1, lang: "en", weekStart: 1, size: PAGE_SIZES.a4,
			sections: { year: true, months: true, weeks: false, days: false, notes: false }, notesPages: 0, linkTarget: "Planner 2026.notebook",
			newId: () => `e${++n}`,
		};
		const { pages } = buildPlanner(o);
		const links = pages.flatMap((p) => (p.elements ?? []).filter((e): e is TextElement => e.type === "text" && soleLink(e.text) !== null));
		expect(links.length).toBeGreaterThan(12);
		for (const el of links) {
			const shown = shownText(el.text).text;
			expect(shown).not.toContain("[[");
			expect(shown.length).toBeLessThan(20);
			// Wide enough for what is shown, at a readable size.
			expect(textElementBounds(el).maxY - el.y).toBeLessThanOrEqual(el.fontSize * 1.25 * 1.01);
		}
	});
});

// ------------------------------------------------------------------------------------------------------------- D1/D2

describe("D1: one analysis per notebook, bounded", () => {
	it("keeps the most recently used notebooks and drops only the oldest", () => {
		const lru = new NotebookLru<{ id: string }>();
		const made: string[] = [];
		const get = (k: string) => lru.get(k, () => { made.push(k); return { id: k }; });
		for (const k of ["a", "b", "c", "d"]) get(k);
		expect(lru.size).toBe(MAX_HEADING_NOTEBOOKS);
		get("a"); // a is now the most recent
		get("e"); // b goes
		expect(lru.has("b")).toBe(false);
		expect(lru.has("a")).toBe(true);
		expect(get("a").id).toBe("a");
		expect(made).toEqual(["a", "b", "c", "d", "e"]);
	});
});

/** A minimal PNG: signature, IHDR, one IDAT, IEND (chunk CRCs are not checked by the helpers, but are written right). */
function tinyPng(): Uint8Array {
	const chunk = (type: string, data: number[]): number[] => {
		const body = [...Array.from(type, (c) => c.charCodeAt(0)), ...data];
		const crc = crc32(Uint8Array.from(body));
		return [(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255, ...body, (crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
	};
	return Uint8Array.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
		...chunk("IDAT", [1, 2, 3, 4]),
		...chunk("IEND", []),
	]);
}

describe("D2: pictures are marked, and only marked ones are ours", () => {
	it("computes the PNG CRC", () => {
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
	});

	it("writes a text chunk after the header and reads it back", () => {
		const png = tinyPng();
		expect(readPngText(png, PICTURE_MARK)).toBeNull();
		const marked = addPngText(png, PICTURE_MARK, "abc123|10,20,30,40");
		expect(readPngText(marked, PICTURE_MARK)).toBe("abc123|10,20,30,40");
		expect(readPngText(marked, "other")).toBeNull();
		// Still the same image: the signature, the header and the data are where they were, with one chunk between.
		expect(Array.from(marked.slice(0, 33))).toEqual(Array.from(png.slice(0, 33)));
		expect(Array.from(marked.slice(marked.length - (png.length - 33)))).toEqual(Array.from(png.slice(33)));
		expect(marked.length).toBe(png.length + 12 + PICTURE_MARK.length + 1 + "abc123|10,20,30,40".length);
	});

	it("handles things that are not PNG pictures", () => {
		const junk = Uint8Array.from([1, 2, 3, 4]);
		expect(addPngText(junk, PICTURE_MARK, "x")).toBe(junk);
		expect(readPngText(junk, PICTURE_MARK)).toBeNull();
		expect(readPngText(new Uint8Array(0), PICTURE_MARK)).toBeNull();
		expect(readPngText(tinyPng().slice(0, 40), PICTURE_MARK)).toBeNull();
	});

	const probes = (files: Record<string, string | null>) => (path: string): Promise<PictureProbe> =>
		Promise.resolve(path in files ? { kind: "file", mark: files[path]! } : { kind: "free" });

	it("creates the picture when nothing is there", async () => {
		expect(await choosePicturePath("A (Headings)/p1-h1.png", "k1", probes({}))).toEqual({ path: "A (Headings)/p1-h1.png", action: "create" });
	});

	it("leaves a picture of the same ink alone, whatever encoder drew it", async () => {
		expect(await choosePicturePath("p1-h1.png", "k1", probes({ "p1-h1.png": "k1" }))).toEqual({ path: "p1-h1.png", action: "keep" });
	});

	it("redraws its own picture when the ink changed", async () => {
		expect(await choosePicturePath("p1-h1.png", "k2", probes({ "p1-h1.png": "k1" }))).toEqual({ path: "p1-h1.png", action: "rewrite" });
	});

	it("never writes over a file without the mark: the next free name is taken, then found again", async () => {
		const mine = { "p1-h1.png": null as string | null };
		expect(await choosePicturePath("p1-h1.png", "k1", probes(mine))).toEqual({ path: "p1-h1 2.png", action: "create" });
		const later = { "p1-h1.png": null as string | null, "p1-h1 2.png": "k1" };
		expect(await choosePicturePath("p1-h1.png", "k1", probes(later))).toEqual({ path: "p1-h1 2.png", action: "keep" });
		expect(await choosePicturePath("p1-h1.png", "k9", probes(later))).toEqual({ path: "p1-h1 2.png", action: "rewrite" });
	});

	it("gives up when every name is the user's", async () => {
		const all: Record<string, string | null> = {};
		for (let n = 1; n <= MAX_PICTURE_NAMES; n++) all[numberedName("p1-h1.png", n)] = null;
		expect(await choosePicturePath("p1-h1.png", "k1", probes(all))).toBeNull();
	});
});

// ------------------------------------------------------------------------------------------------------------- D3

describe("D3: the headings folder is the plugin's, so the inbox never offers its pictures", () => {
	const ctx = (over: Partial<InboxContext> = {}): InboxContext => ({ folder: "", notebooksFolder: "Notebooks", templatesFolder: "", notebookTemplatesFolder: "", ...over });

	it("skips files in a '<Notebook> (Headings)' folder without any record", () => {
		expect(isInboxCandidate("Maths (Headings)/p3-h1.png", ctx({ folder: "Maths (Headings)" }))).toBe(false);
		expect(isInboxCandidate("Sub/Maths (headings)/p3-h1.png", ctx({ folder: "Sub/Maths (headings)" }))).toBe(false);
		expect(isInboxCandidate("Attachments/photo.png", ctx({ folder: "Attachments" }))).toBe(true);
	});
});

// ------------------------------------------------------------------------------------------------------------- D4

describe("D4: a new stroke redraws the ghost guides only when they had started to fade", () => {
	it("does nothing visible while they are fully shown", () => {
		expect(ghostTouchRedraws("always", 5 * GHOST_IDLE_MS)).toBe(false);
		expect(ghostTouchRedraws("writing", 10)).toBe(false);
		expect(ghostTouchRedraws("writing", GHOST_IDLE_MS)).toBe(false);
		expect(ghostTouchRedraws("off", 99_999)).toBe(false);
	});
	it("brings them back at full strength once they were fading", () => {
		expect(ghostTouchRedraws("writing", GHOST_IDLE_MS + 1)).toBe(true);
	});
});

// ------------------------------------------------------------------------------------------------------------- D5

describe("D5: a page is restored only into the notebook the versions belong to", () => {
	const doc = (id: string, pageIds: string[]) => ({ id, pages: pageIds.map((p) => ({ ...createPage(), id: p })) });

	it("refuses another notebook before looking at pages", () => {
		const live = doc("B", ["x", "y"]) as never;
		const old = doc("A", ["a", "b"]) as never;
		expect(planDiffRestoreInto(live, old, "a", [], 0)).toEqual({ kind: "other-notebook" });
	});

	it("plans as usual for the same notebook", () => {
		const live = doc("A", ["a", "b"]) as never;
		const old = doc("A", ["a", "b"]) as never;
		const r = planDiffRestoreInto(live, old, "a", [], 0);
		expect(r.kind).toBe(planDiffRestore(live, old, "a", [], 0).kind);
		expect(r.kind).toBe("ok");
	});
});

// ------------------------------------------------------------------------------------------------------------- D6

describe("D6/K-dropfiles: files are written only when the change goes ahead", () => {
	const run = async (opts: { apply: boolean; failAt?: number; exists?: Set<string> }) => {
		const written: string[] = [];
		const trashed: string[] = [];
		const items = ["a", "b", "c"];
		const exists = opts.exists ?? new Set<string>();
		let applied = false;
		let error: unknown = null;
		let result: boolean | null = null;
		try {
			result = await commitWithFiles(
				items,
				(item) => {
					if (opts.failAt !== undefined && items.indexOf(item) === opts.failAt) return Promise.reject(new Error("disk full"));
					if (exists.has(item)) return Promise.resolve(false); // already in the vault: not ours to throw away
					written.push(item);
					return Promise.resolve(true);
				},
				(item) => { trashed.push(item); return Promise.resolve(); },
				() => { applied = true; return opts.apply; },
			);
		} catch (e) {
			error = e;
		}
		return { written, trashed, applied, error, result };
	};

	it("keeps the files when the History takes the change", async () => {
		const r = await run({ apply: true });
		expect(r).toMatchObject({ written: ["a", "b", "c"], trashed: [], applied: true, result: true });
	});

	it("takes back what it wrote when the History refuses", async () => {
		const r = await run({ apply: false });
		expect(r.result).toBe(false);
		expect(r.trashed.sort()).toEqual(["a", "b", "c"]);
	});

	it("takes back what it wrote when a write fails midway, and does not apply", async () => {
		const r = await run({ apply: true, failAt: 2 });
		expect(r.applied).toBe(false);
		expect((r.error as Error).message).toBe("disk full");
		expect(r.trashed.sort()).toEqual(["a", "b"]);
	});

	it("never trashes a file that was already there", async () => {
		const r = await run({ apply: false, exists: new Set(["b"]) });
		expect(r.trashed.sort()).toEqual(["a", "c"]);
	});

	it("goes on removing when one removal fails", async () => {
		const trashed: string[] = [];
		await commitWithFiles(["a", "b"], () => Promise.resolve(true), (item) => (item === "b" ? Promise.reject(new Error("locked")) : (trashed.push(item), Promise.resolve())), () => false);
		expect(trashed).toEqual(["a"]);
	});
});

// ------------------------------------------------------------------------------------------------------------- D7

describe("D7: a scattered page range keeps the file name short", () => {
	const odd = Array.from({ length: 100 }, (_, i) => i * 2); // pages 1, 3, 5, ... 199

	it("spells a short range out", () => {
		expect(shareSuffix("range", [1, 2, 3, 6])).toBe(" p2-4+7");
		expect(shareSuffix("page", [4])).toBe(" p5");
	});

	it("shortens a long one", () => {
		const suffix = shareSuffix("range", odd);
		expect(suffix).toBe(" p1-199 (100 pages)");
		expect(suffix.length).toBeLessThan(MAX_SHARE_RANGE_CHARS);
		const [name] = shareFileNames("Maths", "pdf", "range", odd);
		expect(name).toBe("Maths p1-199 (100 pages).pdf");
		expect(new TextEncoder().encode(name).length).toBeLessThan(255);
	});
});

// ------------------------------------------------------------------------------------------------------------- D8

describe("D8: the planner's links name the notebook that is really created", () => {
	it("fills the placeholders in first, like the creation does", () => {
		const now = new Date(2026, 10, 5, 9, 30);
		expect(createdNotebookName("Planner {{year}}", now)).toBe("Planner 2026");
		expect(createdNotebookName("  Diary {{date}} ", now)).toBe("Diary 2026-11-05");
		expect(createdNotebookName("Plain name", now)).toBe("Plain name");
		expect(createdNotebookName("A: {{time}}", now)).toBe("A 09 30");
	});
});

// ------------------------------------------------------------------------------------------------------------- D1 index

describe("sanity", () => {
	it("MAX_HEADING_NOTEBOOKS is small", () => {
		expect(MAX_HEADING_NOTEBOOKS).toBeLessThanOrEqual(8);
	});
});
