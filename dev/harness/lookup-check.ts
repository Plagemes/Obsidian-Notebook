/**
 * 0.19 lookup (roadmap #213): "Look up later" on the `doc=lookup` scenario (npm run harness:check). The whole plugin starts against
 * the stub (as task-check.ts does). Checked: an entry is appended to the list note (made when missing) with a real PNG crop that the
 * shared-files inbox will not offer, the lines already in the note stay byte for byte, typed text is escaped, a second entry goes below
 * the first; the word dialog; the sheet lists only this notebook's entries with a count, a thumbnail and a jump to the page by id,
 * reports a deleted page, and fits the screen. The sheet is left open for the screenshot.
 */
import NotebookPlugin from "../../src/main";
import { LookUpSheet, LookUpWordModal, runLookUp, type LookUpHost } from "../../src/view/look-up";
import { createPage, createStroke } from "../../src/model/document";
import { loadWritten } from "../../src/storage/plugin-written";
import { t } from "../../src/i18n";
import { App, type Plugin as StubPlugin } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface LookUpCheckApi {
	errors: string[];
	notices: string[];
}

const MANIFEST = { id: "notebook", name: "Notebook", version: "0.0.0-harness", dir: "plugins/notebook" };
const BS = String.fromCharCode(92);

export async function checkLookUp(api: LookUpCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

	const app = new App();
	const plugin = new NotebookPlugin(app as never, MANIFEST as never) as NotebookPlugin & StubPlugin;
	await plugin.onload();
	const settings = plugin.settings;
	add("the plugin starts with the default list note and a 150 px picture", settings.lookUpNote === "" && settings.lookUpWidth === 150);
	const vault = app.vault;
	const read = async (path: string): Promise<string | null> => {
		const f = vault.getFileByPath(path);
		return f ? vault.read(f) : null;
	};
	const now = new Date(2026, 10, 4, 9, 30, 15);
	const notebook = await vault.create("Notebooks/Maths.notebook", "{}");
	const page = createPage({ width: 595, height: 842 }, { kind: "ruled", spacing: 22.68 });
	page.strokes = [createStroke("#1d4ed8", 3, [[100, 120, 0.5], [180, 150, 0.6], [260, 130, 0.5]], "pen")];
	const host = (): LookUpHost => ({
		app: app as never, file: notebook as never, settings, page, pageNumber: 3, crop: { x: 88, y: 108, width: 190, height: 60 }, media: null, render: {},
	});

	// 1. The first entry makes the note; the picture is a real PNG; the line has everything.
	const listPath = "Notebooks/Look up later.md";
	add("the list note does not exist yet", (await read(listPath)) === null);
	const first = await runLookUp(host(), "", now);
	const text1 = (await read(listPath)) ?? "";
	add("the first entry makes the note", first === listPath && text1 !== "", String(first));
	add("the line has a 150 px picture, the dash, the page link and the date", /^- \[ \] !\[\[Attachments\/Maths lookup p3-093015\.png\|150\]\] — \[\[Notebooks\/Maths\.notebook#p3[^\]]*\|Maths p\. 3\]\] \(2026-11-04\)\n$/u.test(text1), JSON.stringify(text1));
	const picture = vault.getFileByPath("Attachments/Maths lookup p3-093015.png");
	const bytes = picture ? new Uint8Array(await vault.readBinary(picture)) : new Uint8Array();
	add("the crop is a real PNG", bytes.length > 100 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, String(bytes.length));
	add("the picture is remembered as written by the plugin", "Attachments/Maths lookup p3-093015.png" in loadWritten(app));

	// 2. A note with the user's own text: only a line is appended; typed text is escaped; a second entry goes below.
	const original = "# My words\r\n\r\n- [ ] something else\r\n- [x] done one";
	const mine = await vault.create("Words/List.md", original);
	settings.lookUpNote = "Words/List";
	settings.lookUpWidth = 300;
	const second = await runLookUp(host(), "ephemeral *x* [[y]]", new Date(2026, 10, 4, 9, 31, 0));
	const text2 = (await read("Words/List.md")) ?? "";
	add("a configured note is used, and the text already in it stays byte for byte", second === "Words/List.md" && text2.startsWith(`${original}\r\n- [ ] `) && text2.endsWith("\r\n"), JSON.stringify(text2.slice(original.length)));
	add("the width setting is used and the typed text is escaped", text2.includes(`|300]] ephemeral ${BS}*x${BS}* ${BS}[${BS}[y${BS}]${BS}] — `), JSON.stringify(text2.slice(original.length)));
	await runLookUp(host(), "second", new Date(2026, 10, 4, 9, 32, 0));
	const text3 = (await read("Words/List.md")) ?? "";
	add("a second entry is appended below the first", text3.startsWith(text2) && text3.split("\n").filter((l) => l.includes("— [[")).length === 2);
	add("…and the note file is the same one", vault.getFileByPath("Words/List.md") === mine);
	api.errors.splice(0, api.errors.length);

	// 3. The word dialog.
	const dialog = new LookUpWordModal(app as never, 3, () => undefined);
	dialog.open();
	await sleep(40);
	add("the dialog has a text field and two buttons", !!document.querySelector(".notebook-lookup-modal #nb-lookup-word") && document.querySelectorAll(".notebook-lookup-modal .nb-modal-btn").length === 2);
	dialog.close();
	await sleep(40);

	// 4. The sheet: this notebook's entries only, a count, a jump by id.
	settings.lookUpNote = "";
	const link = (name: string, sub: string) => `[[Notebooks/${name}.notebook${sub}|${name}]]`;
	const list = [
		"# Look up later", "",
		`- [ ] ![[Attachments/Maths lookup p3-093015.png|150]] ephemeral — ${link("Maths", `#p3&id=${page.id}`)} (2026-11-04)`,
		`- [x] ubiquitous — ${link("Maths", "#p1")} (2026-11-03)`,
		`- [ ] elsewhere — ${link("Physics", "#p2")} (2026-11-02)`,
		`- [ ] ![[Attachments/Maths lookup p3-093015.png|150]] — ${link("Maths", "#p9&id=gone-page")} (2026-11-01)`,
	].join("\n");
	const listFile = vault.getFileByPath(listPath);
	if (listFile) await vault.modify(listFile, list);
	await vault.create("Notebooks/Physics.notebook", "{}");
	const jumps: number[] = [];
	const pages = [{ id: "p-a" }, { id: "p-b" }, { id: page.id }, { id: "p-d" }];
	const sheet = new LookUpSheet({ app: app as never, file: notebook as never, settings, pages: () => pages, goTo: (i) => jumps.push(i) });
	sheet.open();
	await sleep(80);
	const q = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(`.notebook-lookup-sheet ${sel}`));
	add("the sheet lists only this notebook's entries", q(".nb-lookup-row").length === 3, String(q(".nb-lookup-row").length));
	add("the count says 2 to look up of 3", q(".nb-modal-section-title").some((e) => e.textContent === t("lookup.sheet.count", { open: "2", total: "3" })), q(".nb-modal-section-title").map((e) => e.textContent).join("|"));
	add("a ticked entry is dimmed and a picture-only entry says so", q(".nb-lookup-row.is-done").length === 1 && q(".nb-lookup-word").some((e) => e.textContent === t("lookup.sheet.noWord")));
	add("a row shows its page and date", q(".nb-lookup-meta").some((e) => e.textContent === `${t("lookup.sheet.page", { n: "3" })} · 2026-11-04`), q(".nb-lookup-meta").map((e) => e.textContent).join("|"));
	add("the thumbnail is the stored crop", q(".nb-lookup-thumb img").length === 2 && q(".nb-lookup-thumb img").every((i) => (i as HTMLImageElement).src.startsWith("blob:")), String(q(".nb-lookup-thumb img").length));
	const rows = q(".nb-lookup-row");
	const noticesBefore = api.notices.length;
	rows[2]?.click();
	add("a deleted page says so and does not move the view", jumps.length === 0 && api.notices.slice(noticesBefore).includes(t("lookup.sheet.gone")) && q(".nb-lookup-row").length === 3);
	rows[0]?.click();
	await sleep(40);
	add("a row jumps to the page by its id", jumps.length === 1 && jumps[0] === 2, jumps.join(","));
	add("the sheet closed after the jump", q(".nb-lookup-row").length === 0);
	api.errors.splice(0, api.errors.length);
	const again = new LookUpSheet({ app: app as never, file: notebook as never, settings, pages: () => pages, goTo: (i) => jumps.push(i) });
	again.open();
	await sleep(80);
	const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".notebook-lookup-sheet .nb-modal-btn")).filter((b) => b.getBoundingClientRect().height > 0);
	add("every footer button is a 40 px target", buttons.length === 2 && buttons.every((b) => b.getBoundingClientRect().height >= 40), buttons.map((b) => Math.round(b.getBoundingClientRect().height)).join(","));
	const box = document.querySelector<HTMLElement>(".notebook-lookup-sheet");
	add("the sheet fits the screen", !!box && box.getBoundingClientRect().left >= 0 && box.getBoundingClientRect().right <= window.innerWidth + 1);
	if (box && !box.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(box);
	await sleep(40);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
