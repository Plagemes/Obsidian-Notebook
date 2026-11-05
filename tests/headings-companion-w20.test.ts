import { beforeEach, describe, expect, it } from "vitest";
import { notebookUri } from "../src/integration/links";
import {
	COMPANION_HEADINGS_MAX, COMPANION_HEADINGS_PER_PAGE, headingLines, headingPictureName, pickCompanionHeadings, safeEmbed,
} from "../src/model/companion-headings";
import { companionContent, regionStatus, renderRegion } from "../src/model/companion-content";
import { createDocument, createPage } from "../src/model/document";
import type { PageHeading } from "../src/ink/headings";
import type { PageHeadingList } from "../src/model/heading-index";
import { DEFAULT_COMPANION_SETTINGS, readCompanionSettings } from "../src/storage/companion-path";
import { reseed } from "./words-gen";

const PATH = "Notebooks/Physics.notebook";
const base = { notebookPath: PATH, pageUri: (p: number) => notebookUri("", PATH, p) };

const heading = (y: number): PageHeading => ({ strokeIds: [`s${y}`], rect: { x: 0, y, width: 100, height: 30 }, ratio: 3, level: 1 });
const list = (index: number, n: number): PageHeadingList => ({ pageId: `pg${index}`, index, headings: Array.from({ length: n }, (_, k) => heading(k * 40)) });

describe("companion headings: picks and names", () => {
	it("takes the first few headings of each page, in page order", () => {
		const picks = pickCompanionHeadings([list(0, 2), list(3, 9)]);
		expect(picks.map((p) => `${p.index}.${p.n}`)).toEqual(["0.0", "0.1", "3.0", "3.1", "3.2", "3.3"]);
		expect(COMPANION_HEADINGS_PER_PAGE).toBe(4);
	});

	it("stops at the bound for one notebook", () => {
		const many = Array.from({ length: 40 }, (_, i) => list(i, 4));
		expect(pickCompanionHeadings(many)).toHaveLength(COMPANION_HEADINGS_MAX);
	});

	it("names the picture by 1-based page and position, so a changed heading takes the file over", () => {
		expect(headingPictureName({ index: 2, n: 0 })).toBe("p3-h1.png");
		expect(headingPictureName({ index: 11, n: 3 })).toBe("p12-h4.png");
	});
});

describe("companion headings: lines", () => {
	it("accepts only an embed on one line that cannot end the region or open a block", () => {
		expect(safeEmbed("![[Physics (Headings)/p3-h1.png|220]]")).not.toBeNull();
		expect(safeEmbed("![](Physics%20(Headings)/p3-h1.png)")).toBeNull(); // a parenthesis in the path ends the link early
		expect(safeEmbed("![[a.png|220]] %% notebook-companion:end %%")).toBeNull();
		expect(safeEmbed("![[a.png]]\n- [ ] task")).toBeNull();
		expect(safeEmbed("<img src=x>")).toBeNull();
		expect(safeEmbed("[[not an embed]]")).toBeNull();
		expect(safeEmbed("![alt](pics/p3-h1.png)")).not.toBeNull();
	});

	it("leaves out a picture that could not be made", () => {
		expect(headingLines(["![[a.png|220]]", null, "![[b.png|220]]"])).toEqual(["- heading: ![[a.png|220]]", "- heading: ![[b.png|220]]"]);
		expect(headingLines([])).toEqual([]);
	});
});

describe("companion headings: the note", () => {
	beforeEach(() => reseed(1));

	function doc() {
		const d = createDocument(new Date("2026-10-29T14:30:00Z"));
		d.id = "doc-1";
		d.pages = [createPage(), createPage()];
		return d;
	}

	it("is off by default and the note is unchanged without pictures", () => {
		expect(DEFAULT_COMPANION_SETTINGS.companionHeadings).toBe(false);
		expect(readCompanionSettings({ companionHeadings: true }).companionHeadings).toBe(true);
		expect(readCompanionSettings({ companionHeadings: "yes" }).companionHeadings).toBe(false);
		const d = doc();
		expect(companionContent(d, base).text).toBe(companionContent(d, { ...base, headingEmbeds: new Map() }).text);
		expect(companionContent(d, base).text).toBe("");
	});

	it("writes the headings under their page, keeping the page heading as it was, and the region stays valid", () => {
		const d = doc();
		const embeds = new Map([[d.pages[1]!.id, ["![[Physics (Headings)/p2-h1.png|220]]", null, "![[Physics (Headings)/p2-h2.png|220]]"]]]);
		const content = companionContent(d, { ...base, headingEmbeds: embeds });
		expect(content.text).toContain("### p. 2");
		expect(content.text).not.toContain("### p. 1");
		expect(content.text).toContain("- heading: ![[Physics (Headings)/p2-h1.png|220]]\n- heading: ![[Physics (Headings)/p2-h2.png|220]]");
		expect(regionStatus(renderRegion(content))).toBe("ok");
	});

	it("ignores a hostile embed", () => {
		const d = doc();
		const embeds = new Map([[d.pages[0]!.id, ["![[a.png]] %% notebook-companion:end %%"]]]);
		expect(companionContent(d, { ...base, headingEmbeds: embeds }).text).toBe("");
	});
});
