/**
 * Smoke check of the Highlights digest (0.16, roadmap #90) on the `doc=digest` notebook (npm run harness:check): three
 * slides of the fake PDF (two yellow lines on the first, a green one on the second) and a notes page with handwriting under
 * a pink highlighter. The real view's dialog is opened and driven through the DOM; the note it writes is read back from the
 * stand-in vault: markers, one picture per region (drawn from the real renderer: PDF text pixels, highlighter tint, ink),
 * the PDF text quoted, links to the pages; a second run keeps what the reader wrote around the section, creates no new
 * pictures and, run again, changes nothing; a note with an unpaired marker is left alone. It leaves the dialog open for
 * the screenshot.
 */
import { createDocument, createPage, createStroke } from "../../src/model/document";
import { createPdfPages } from "../../src/model/pages";
import { serialize } from "../../src/model/serialize";
import type { Page, Stroke } from "../../src/model/types";
import { reseed, writeLine } from "../../tests/words-gen";
import { FAKE_ASSET, FAKE_PAGE, FAKE_PATH } from "./fake-pdf";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface DigestCheckApi {
	/** The notebook view (a `HarnessView`). */
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

const YELLOW = "#facc15";
const GREEN = "#4ade80";
const PINK = "#f472b6";

/** A straight highlighter stroke along a line of text. */
function hl(x0: number, x1: number, y: number, color: string, width = 14): Stroke {
	const points: Array<[number, number, number]> = [];
	for (let x = x0; x <= x1; x += 4) points.push([x, y, 0.5]);
	return createStroke(color, width, points, "highlighter");
}

/** Serialised notebook of the check. The lines of the fake PDF are at baselines 140 and 160 (page 1) and 160 (page 2). */
export function digestNotebook(): string {
	reseed(11);
	const doc = createDocument();
	doc.assets = { [FAKE_ASSET]: { id: FAKE_ASSET, kind: "pdf", path: FAKE_PATH, name: "Slides.pdf", bytes: 8 } };
	const slides = createPdfPages(doc.assets[FAKE_ASSET]!, Array.from({ length: 3 }, () => ({ ...FAKE_PAGE })));
	slides[0]!.strokes = [hl(72, 330, 133, YELLOW), hl(72, 250, 153, YELLOW)];
	slides[1]!.strokes = [hl(72, 300, 153, GREEN)];
	const notes: Page = createPage({ width: FAKE_PAGE.width, height: FAKE_PAGE.height }, { kind: "ruled", spacing: 22.68 });
	notes.strokes = [...writeLine("dg", "limits and series", { x: 60, baseY: 120, H: 30 }), hl(60, 330, 108, PINK, 20)];
	doc.pages = [...slides, notes];
	return serialize(doc);
}

interface AppLike {
	vault: {
		getFileByPath(p: string): { path: string; extension: string } | null;
		getFiles(): Array<{ path: string; extension: string }>;
		read(f: unknown): Promise<string>;
		readBinary(f: unknown): Promise<ArrayBuffer>;
		process(f: unknown, fn: (s: string) => string): Promise<string>;
	};
}

export async function checkDigest(api: DigestCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as HarnessView & { app: AppLike; openHighlightsDigest(): void };
	const app = v.app;
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const NOTE = "Notebooks/Digest — Highlights.md";
	const modal = (): HTMLElement | null => document.querySelector<HTMLElement>(".notebook-digest-modal");
	const noteFile = () => app.vault.getFileByPath(NOTE);
	const noteText = async (): Promise<string> => {
		const f = noteFile();
		return f ? app.vault.read(f) : "";
	};
	const pictures = () => app.vault.getFiles().filter((f) => f.extension === "png" && f.path.includes("highlight p"));
	const settle = async (before: number): Promise<void> => {
		for (let i = 0; i < 200 && !api.notices.slice(before).some((n) => /Highlights digest written|digest marker|failed/.test(n)); i++) await sleep(50);
		await frames(2);
	};

	const open = async (): Promise<HTMLElement | null> => {
		v.openHighlightsDigest();
		await frames(3);
		const m = modal();
		if (m && !m.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(m.closest(".modal") ?? m);
		await frames(2);
		return modal();
	};
	const run = async (group?: "page" | "colour"): Promise<void> => {
		const m = await open();
		if (!m) return;
		const select = m.querySelectorAll<HTMLSelectElement>("select")[0];
		if (group && select) {
			select.value = group;
			select.dispatchEvent(new Event("change"));
		}
		const before = api.notices.length;
		m.querySelector<HTMLButtonElement>(".nb-modal-btn-primary, button.mod-cta, .nb-modal-foot button:last-child")?.click();
		await settle(before);
	};

	// The dialog.
	const first = await open();
	add("the digest dialog opens", first !== null);
	add("it says how many highlights there are", (first?.textContent ?? "").includes("3 highlights"), first?.textContent?.slice(0, 160) ?? "");
	add("it offers grouping and picture quality", (first?.querySelectorAll("select").length ?? 0) === 2, `${first?.querySelectorAll("select").length ?? 0} selects`);
	add("the primary button creates the digest", /Create the digest/.test(first?.textContent ?? ""), "");
	first?.querySelector<HTMLButtonElement>(".nb-modal-foot button:first-child")?.click();
	await frames(2);

	// First run, grouped by page.
	await run("page");
	const text = await noteText();
	add("the note is written next to the notebook", noteFile() !== null && text.length > 0, NOTE);
	add("it has the start and end markers", text.includes("<!-- notebook-digest:start -->") && text.includes("<!-- notebook-digest:end -->"), "");
	add("it is grouped by page", /^## \[\[Notebooks\/Digest\.notebook#p1&id=[^|\]]+\|Page 1\]\]$/mu.test(text) && /^## .*Page 2/mu.test(text) && /^## .*Page 4/mu.test(text), text.match(/^## .*$/gmu)?.join(" ; ") ?? "");
	add("it quotes the PDF text under the first highlight", /^> .*quick brown fox/mu.test(text), text.match(/^> .*$/gmu)?.join(" / ") ?? "");
	add("the second slide quotes its own line", /^> .*QUICK reader/mu.test(text), "");
	add("a notes page highlight has a picture but no quote", (text.split("## ")[3] ?? "").includes("![[") && !(text.split("## ")[3] ?? "").includes("> "), "");
	const embeds = [...text.matchAll(/!\[\[([^\]]+)\]\]/gu)].map((m) => m[1]!);
	add("one picture per region (3)", embeds.length === 3 && pictures().length === 3, `${embeds.length} embeds, ${pictures().length} files`);
	add("pictures are in the attachments folder", pictures().every((f) => f.path.startsWith("Attachments/")), pictures().map((f) => f.path).join(", "));
	add("the colour is named under each picture", text.includes("Yellow") && text.includes("Green") && text.includes("Pink"), "");

	// What the pictures look like.
	const stats = async (path: string): Promise<{ w: number; h: number; tinted: number; dark: number }> => {
		const file = app.vault.getFileByPath(path)!;
		const bmp = await createImageBitmap(new Blob([await app.vault.readBinary(file)], { type: "image/png" }));
		const c = createEl("canvas");
		c.width = bmp.width;
		c.height = bmp.height;
		const ctx = c.getContext("2d")!;
		ctx.drawImage(bmp, 0, 0);
		const px = ctx.getImageData(0, 0, c.width, c.height).data;
		let tinted = 0, dark = 0;
		for (let i = 0; i < px.length; i += 4) {
			const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
			if (r > 200 && g > 160 && b < 170 && r - b > 60) tinted++;
			if (r < 110 && g < 110 && b < 110) dark++;
		}
		return { w: bmp.width, h: bmp.height, tinted, dark };
	};
	const sorted = pictures().map((f) => f.path).sort();
	const s1 = sorted[0] ? await stats(sorted[0]) : null;
	const s4 = sorted[2] ? await stats(sorted[2]) : null;
	add("a picture is a crop, not the whole page", !!s1 && s1.w > 100 && s1.w < 1000 && s1.h > 40 && s1.h < 400, s1 ? `${s1.w}x${s1.h}` : "none");
	add("the first picture shows the highlight over the PDF text", !!s1 && s1.tinted > 500 && s1.dark > 100, JSON.stringify(s1));
	add("the notes picture shows the ink", !!s4 && s4.dark > 100, JSON.stringify(s4));

	// The reader writes around the section; a second run groups by colour.
	const f = noteFile()!;
	await app.vault.process(f, (s) => `MY INTRO\n\n${s}\n\nMY OUTRO\n`);
	const files = pictures().length;
	await run("colour");
	const byColour = await noteText();
	add("the reader's text outside the markers is kept", byColour.startsWith("MY INTRO\n\n") && byColour.endsWith("\n\nMY OUTRO\n"), "");
	add("grouped by colour", /^## Yellow$/mu.test(byColour) && /^## Green$/mu.test(byColour) && /^## Pink$/mu.test(byColour) && !/^## .*Page/mu.test(byColour), byColour.match(/^## .*$/gmu)?.join(" ; ") ?? "");
	add("each highlight links back to its page", (byColour.match(/#p\d&id=/gu) ?? []).length === 3, "");
	add("no new picture files on the second run", pictures().length === files, `${files} -> ${pictures().length}`);
	await run("colour");
	add("running it again changes nothing", (await noteText()) === byColour, "");

	// An unpaired marker is never overwritten.
	const broken = byColour.replace("<!-- notebook-digest:end -->", "");
	await app.vault.process(f, () => broken);
	const before = api.notices.length;
	await run("page");
	add("a note with an unpaired marker is left untouched", (await noteText()) === broken && api.notices.slice(before).some((n) => /marker/.test(n)), api.notices.slice(before).join(" | "));
	await app.vault.process(f, () => byColour);

	// Leave the dialog open for the screenshot.
	await open();
	add("the dialog offers to update the existing note", /Update the digest/.test(modal()?.textContent ?? ""), "");

	return { ok: results.every((r) => r.ok), results, errors: api.errors, notices: api.notices, env: { pictures: pictures().length } };
}
