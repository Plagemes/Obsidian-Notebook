/** 0.16 review fixes on the highlights digest (C5, C6). */
import { describe, expect, it, vi } from "vitest";
import { DIGEST_END, DIGEST_START, alternativeDigestName, canRewritePicture, sectionImageLinks, sectionImageNames, wouldAppendToUserNote } from "../src/model/highlight-digest";
import { FakeTFile } from "./fake-vault";

vi.mock("obsidian", async () => (await import("./fake-vault")).obsidianMock());

const { storePicture } = await import("../src/view/highlight-digest");

const NOTE = "Maths/Maths — Highlights.md";

describe("C5: digest pictures are only rewritten when they are the digest's own", () => {
	it("keeps the link as written for each picture of the old section", () => {
		const section = "![[Pics/Maths highlight p1-1.png]]\n![alt](Pics/My%20nb%20highlight%20p2-1.png)\n![[Maths highlight p3-1.png|300]]";
		const links = sectionImageLinks(section);
		expect(links.get("maths highlight p1-1.png")).toBe("Pics/Maths highlight p1-1.png");
		expect(links.get("my nb highlight p2-1.png")).toBe("Pics/My nb highlight p2-1.png");
		expect(links.get("maths highlight p3-1.png")).toBe("Maths highlight p3-1.png");
		expect([...sectionImageNames(section)].sort()).toEqual([...links.keys()].sort());
	});

	const check = (over: Partial<Parameters<typeof canRewritePicture>[0]> = {}) => canRewritePicture({
		foundPath: "Maths/att/Maths highlight p1-1.png", name: "Maths highlight p1-1.png", expectedDir: "Maths/att", notePath: NOTE, linkedFrom: [NOTE], ...over,
	});

	it("allows the digest's own picture in the attachment folder, used by the digest note only", () => {
		expect(check()).toBe(true);
		expect(check({ linkedFrom: [] })).toBe(true);
		expect(check({ foundPath: "maths/ATT/maths highlight p1-1.PNG" })).toBe(true);
	});

	it("refuses another folder, another name, or a file another note uses", () => {
		expect(check({ foundPath: "Chem/att/Maths highlight p1-1.png" })).toBe(false);
		expect(check({ foundPath: "Maths/att/Holiday.png" })).toBe(false);
		expect(check({ linkedFrom: [NOTE, "Daily/2026-11-04.md"] })).toBe(false);
		expect(check({ expectedDir: "", foundPath: "Maths highlight p1-1.png" })).toBe(true);
	});
});

/** A tiny vault around FakeTFile for storePicture: files with bytes, a link index and an attachments folder. */
function setup(files: Record<string, number[]>, resolvedLinks: Record<string, Record<string, number>> = {}, linkToPath: Record<string, string> = {}) {
	const bytes = new Map<string, ArrayBuffer>();
	const tfiles = new Map<string, FakeTFile>();
	for (const [p, b] of Object.entries(files)) {
		tfiles.set(p, new FakeTFile(p));
		bytes.set(p, new Uint8Array(b).buffer);
	}
	const writes: string[] = [];
	const created: string[] = [];
	const app = {
		vault: {
			getFileByPath: (p: string) => tfiles.get(p) ?? null,
			readBinary: async (f: FakeTFile) => bytes.get(f.path)!,
			modifyBinary: async (f: FakeTFile, d: ArrayBuffer) => void (bytes.set(f.path, d), writes.push(f.path)),
			createBinary: async (p: string, d: ArrayBuffer) => {
				const f = new FakeTFile(p);
				tfiles.set(p, f);
				bytes.set(p, d);
				created.push(p);
				return f;
			},
			getAbstractFileByPath: (p: string) => tfiles.get(p) ?? null,
			createFolder: async () => undefined,
		},
		metadataCache: {
			resolvedLinks,
			getFirstLinkpathDest: (link: string) => {
				const p = linkToPath[link];
				return p ? tfiles.get(p) ?? null : null;
			},
		},
		fileManager: {
			getAvailablePathForAttachment: async (name: string) => {
				let path = `Maths/att/${name}`;
				for (let i = 1; tfiles.has(path); i++) path = `Maths/att/${name.replace(/\.png$/, "")} ${i}.png`;
				return path;
			},
			generateMarkdownLink: (f: FakeTFile) => `[[${f.name}]]`,
		},
		loadLocalStorage: () => null,
		saveLocalStorage: () => undefined,
	};
	return { app: app as unknown as Parameters<typeof storePicture>[0], bytes, writes, created };
}

const png = (...b: number[]) => new Blob([new Uint8Array(b)]);
const NAME = "Maths highlight p1-1.png";

describe("C5: storePicture", () => {
	it("rewrites its own earlier picture in place when the bytes changed", async () => {
		const s = setup({ [`Maths/att/${NAME}`]: [1, 2, 3] }, { [NOTE]: { [`Maths/att/${NAME}`]: 1 } }, { [NAME]: `Maths/att/${NAME}` });
		const out = await storePicture(s.app, NOTE, NAME, png(9, 9, 9), new Map([[NAME.toLowerCase(), NAME]]));
		expect(out).toContain(NAME);
		expect(s.writes).toEqual([`Maths/att/${NAME}`]);
		expect(s.created).toEqual([]);
	});

	it("does not write again when the bytes are identical", async () => {
		const s = setup({ [`Maths/att/${NAME}`]: [1, 2, 3] }, {}, { [NAME]: `Maths/att/${NAME}` });
		const out = await storePicture(s.app, NOTE, NAME, png(1, 2, 3), new Map([[NAME.toLowerCase(), NAME]]));
		expect(out).not.toBeNull();
		expect(s.writes).toEqual([]);
		expect(s.created).toEqual([]);
	});

	it("never overwrites a picture of the same name that another note uses: it writes a new file", async () => {
		const s = setup({ [`Maths/att/${NAME}`]: [1, 2, 3] }, { "Other/Essay.md": { [`Maths/att/${NAME}`]: 1 } }, { [NAME]: `Maths/att/${NAME}` });
		await storePicture(s.app, NOTE, NAME, png(9, 9, 9), new Map([[NAME.toLowerCase(), NAME]]));
		expect(s.writes).toEqual([]);
		expect(s.created).toEqual([`Maths/att/Maths highlight p1-1 1.png`]);
		expect([...new Uint8Array(s.bytes.get(`Maths/att/${NAME}`)!)]).toEqual([1, 2, 3]);
	});

	it("never overwrites a same-named picture of another notebook found elsewhere in the vault", async () => {
		// The old section links to Chem/att/...: not where this digest's attachments go.
		const other = `Chem/att/${NAME}`;
		const s = setup({ [other]: [7, 7] }, {}, { [`Chem/att/${NAME}`]: other });
		await storePicture(s.app, NOTE, NAME, png(1), new Map([[NAME.toLowerCase(), `Chem/att/${NAME}`]]));
		expect(s.writes).toEqual([]);
		expect(s.created).toEqual([`Maths/att/${NAME}`]);
	});

	it("creates the picture when the old link no longer resolves", async () => {
		const s = setup({});
		await storePicture(s.app, NOTE, NAME, png(1), new Map([[NAME.toLowerCase(), NAME]]));
		expect(s.created).toEqual([`Maths/att/${NAME}`]);
	});
});

describe("C6: a user note with the digest's name is not written into without asking", () => {
	it("asks only when the section would be appended to a note that has text and no markers", () => {
		expect(wouldAppendToUserNote("My own notes about Maths\n")).toBe(true);
		expect(wouldAppendToUserNote("")).toBe(false);
		expect(wouldAppendToUserNote("  \n")).toBe(false);
		// The note of an earlier digest is rebuilt in place, as before.
		expect(wouldAppendToUserNote(`# T\n${DIGEST_START}\nold\n${DIGEST_END}\nmine`)).toBe(false);
		// A broken marker is "unsafe", refused elsewhere, never offered as an append.
		expect(wouldAppendToUserNote(`text ${DIGEST_START} no end`)).toBe(false);
	});

	it("offers a free second note name next to it", () => {
		const taken = new Set(["Maths — Highlights.md", "Maths — Highlights 2.md"]);
		expect(alternativeDigestName("Maths — Highlights.md", (n) => taken.has(n))).toBe("Maths — Highlights 3.md");
		expect(alternativeDigestName("Maths — Highlights.md", (n) => n === "Maths — Highlights.md")).toBe("Maths — Highlights 2.md");
	});
});
