import { describe, expect, it, vi } from "vitest";
import { choosePicturePath, type PictureProbe } from "../src/model/companion-pictures";
import { addPngText, crc32, PIXEL_SUM_KEYWORD, pngPixelSum, readPngText } from "../src/model/png-text";
import { lineRuns, linksInCodePoints } from "../src/ink/link-text";
import { shownText } from "../src/ink/wikilink";
import { toWinAnsi } from "../src/pdf/helvetica";
import { isInboxCandidate, type InboxContext } from "../src/library/shared-inbox-logic";
import { placeRefs } from "../src/view/textbook-ref";
import { commitWithFiles } from "../src/view/drop-files-logic";

// ----------------------------------------------------------------------------------------------------------- N1

describe("N1: a step after the commit can never trash the dropped files", () => {
	const run = async (after: (() => void) | undefined, apply = true) => {
		const trashed: string[] = [];
		const result = await commitWithFiles(["a", "b"], () => Promise.resolve(true), (i) => (trashed.push(i), Promise.resolve()), () => apply, after);
		return { result, trashed };
	};

	it("keeps the files when the step after the commit throws", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const r = await run(() => { throw new Error("select failed"); });
		spy.mockRestore();
		expect(r).toEqual({ result: true, trashed: [] });
	});

	it("runs the step only once the change was taken", async () => {
		const after = vi.fn();
		await run(after, false);
		expect(after).not.toHaveBeenCalled();
		await run(after, true);
		expect(after).toHaveBeenCalledTimes(1);
	});

	it("still takes the files back when the History refuses", async () => {
		expect(await run(undefined, false)).toEqual({ result: false, trashed: ["b", "a"] });
	});
});

// ----------------------------------------------------------------------------------------------------------- N3

/** A minimal PNG: signature, IHDR, IDAT(data), IEND. */
function png(data: number[]): Uint8Array {
	const chunk = (type: string, d: number[]): number[] => {
		const body = [...Array.from(type, (c) => c.charCodeAt(0)), ...d];
		const crc = crc32(Uint8Array.from(body));
		return [(d.length >>> 24) & 255, (d.length >>> 16) & 255, (d.length >>> 8) & 255, d.length & 255, ...body, (crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
	};
	return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]), ...chunk("IDAT", data), ...chunk("IEND", [])]);
}

describe("N3: a heading picture the user edited is not rewritten", () => {
	it("sums the pixels only, so text chunks do not change it", () => {
		const plain = png([1, 2, 3, 4]);
		expect(pngPixelSum(plain)).toMatch(/^[0-9a-f]{8}$/);
		expect(pngPixelSum(addPngText(plain, "x", "y"))).toBe(pngPixelSum(plain));
		expect(pngPixelSum(png([9, 9, 9, 9]))).not.toBe(pngPixelSum(plain));
		expect(pngPixelSum(Uint8Array.from([1, 2, 3]))).toBeNull();
	});

	it("tells an edited picture (marks kept, pixels changed) from the one the plugin wrote", () => {
		const written = png([1, 2, 3, 4]);
		const marked = addPngText(addPngText(written, "notebook-heading", "k1"), PIXEL_SUM_KEYWORD, pngPixelSum(written)!);
		const intactOf = (bytes: Uint8Array) => readPngText(bytes, PIXEL_SUM_KEYWORD) === pngPixelSum(bytes);
		expect(intactOf(marked)).toBe(true);
		// An editor that keeps the text chunks but re-encodes the pixels.
		const edited = addPngText(addPngText(png([5, 6, 7, 8]), "notebook-heading", "k1"), PIXEL_SUM_KEYWORD, pngPixelSum(written)!);
		expect(intactOf(edited)).toBe(false);
	});

	const probes = (files: Record<string, { mark: string | null; intact?: boolean }>) => (path: string): Promise<PictureProbe> =>
		Promise.resolve(path in files ? { kind: "file", ...files[path]! } : { kind: "free" });

	it("rewrites an intact stale picture of its own", async () => {
		expect(await choosePicturePath("p1-h1.png", "k2", probes({ "p1-h1.png": { mark: "k1", intact: true } }))).toEqual({ path: "p1-h1.png", action: "rewrite" });
	});

	it("takes the next free name beside an edited one and leaves it alone", async () => {
		expect(await choosePicturePath("p1-h1.png", "k2", probes({ "p1-h1.png": { mark: "k1", intact: false } }))).toEqual({ path: "p1-h1 2.png", action: "create" });
	});

	it("keeps a picture of the same ink even if it was edited", async () => {
		expect(await choosePicturePath("p1-h1.png", "k1", probes({ "p1-h1.png": { mark: "k1", intact: false } }))).toEqual({ path: "p1-h1.png", action: "keep" });
	});
});

// ----------------------------------------------------------------------------------------------------------- N4

describe("N4: textbook reference chips follow the displayed text", () => {
	const measure = (s: string) => Array.from(s).length * 10;
	const box = (text: string) => ({ x: 0, y: 0, width: 1000, fontSize: 10, text });

	it("places a reference after a link by the label width, not by the markup", () => {
		const [r] = placeRefs(box("[[Some Long Note Name|Ch]] p. 5"), measure);
		// Shown: "Ch p. 5"; the reference starts after "Ch " (3 characters).
		expect(r!.rect.x).toBe(30);
		expect(r!.page).toBe(5);
	});

	it("skips a page reference that lies in a link", () => {
		expect(placeRefs(box("see [[Planner#p14&id=d71|p. 14]] here"), measure)).toEqual([]);
		expect(placeRefs(box("[[Planner.notebook#p14&id=d71]]"), measure)).toEqual([]);
	});

	it("is unchanged for text without links", () => {
		const [r] = placeRefs(box("see p. 134"), measure);
		expect(r!.rect.x).toBe(40);
	});
});

// ----------------------------------------------------------------------------------------------------------- N5

describe("N5: PDF link runs stay on the right characters after an emoji", () => {
	it("counts link offsets in code points", () => {
		const shown = shownText("\u{1F600} [[Note|Link]] end");
		expect(shown.links[0]!.start).toBe(3); // UTF-16: the emoji is two units
		expect(linksInCodePoints(shown.text, shown.links)[0]).toMatchObject({ start: 2, end: 6 });
	});

	it("cuts the WinAnsi code string into the linked label, not one character off", () => {
		const shown = shownText("\u{1F600} [[Note|Link]] end");
		const codes = String.fromCharCode(...toWinAnsi(shown.text));
		const runs = lineRuns(codes, [codes], linksInCodePoints(shown.text, shown.links))[0]!;
		const linked = runs.filter((r) => r.link).map((r) => r.text).join("");
		expect(linked.length).toBe(4);
		expect(runs.map((r) => r.text).join("")).toBe(codes);
		// Without the mapping the span would be one character off.
		const wrong = lineRuns(codes, [codes], shown.links)[0]!;
		expect(wrong.filter((r) => r.link).map((r) => r.text).join("")).not.toBe(linked);
	});
});

// ----------------------------------------------------------------------------------------------------------- N6

describe("N6: only a (Headings) folder the plugin made is hidden from the inbox", () => {
	const ctx = (folder: string, notebooks: string[]): InboxContext => ({
		folder, notebooksFolder: "Notebooks", templatesFolder: "", notebookTemplatesFolder: "",
		hasNotebookNamed: (stem) => notebooks.includes(stem),
	});

	it("hides the folder beside its notebook", () => {
		expect(isInboxCandidate("Maths (Headings)/p3-h1.png", ctx("Maths (Headings)", ["Maths"]))).toBe(false);
		expect(isInboxCandidate("Sub/Maths (Headings)/p3-h1.png", ctx("Sub/Maths (Headings)", ["Sub/Maths"]))).toBe(false);
	});

	it("offers the files of a user folder that only ends the same way", () => {
		expect(isInboxCandidate("Course (Headings)/scan.png", ctx("Course (Headings)", ["Maths"]))).toBe(true);
	});

	it("offers them when the companion check is not available", () => {
		const bare: InboxContext = { folder: "Course (Headings)", notebooksFolder: "Notebooks", templatesFolder: "", notebookTemplatesFolder: "" };
		expect(isInboxCandidate("Course (Headings)/scan.png", bare)).toBe(true);
	});
});
