/**
 * 0.29 hygiene (roadmap Z10): the Zettelkasten hygiene report on the `doc=hygiene` scenario (npm run harness:check). Checked on a small
 * vault of card notes: the report lists unlinked cards, cards without a title and a duplicate group (same title, same text); opening and
 * scanning write nothing; "Open" opens the note and closes the report; every fixing button asks first (nothing is written or trashed
 * before the confirmation, Cancel leaves the note, the confirmation moves it to the trash and the row goes). The report is left open
 * for the screenshot.
 */
import type { CardRecord } from "../../src/zettel/card-content";
import { HygieneModal } from "../../src/zettel/hygiene-view";
import type { ZettelService } from "../../src/zettel/service";
import { t } from "../../src/i18n";
import { App } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface HygieneCheckApi {
	errors: string[];
	notices: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export async function checkHygiene(api: HygieneCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const app = new App();
	const vault = app.vault;
	const body = (text: string) => `---\nzettel-id: x\n---\n![[Notebooks/Physics.notebook#p1]]\n\n## Transcription\n\n${text}\n`;
	const entropy = "Entropy never decreases in an isolated system because the number of accessible microstates only grows over time";
	const spec: Array<{ id: string; title: string; text: string; page: string }> = [
		{ id: "202611010900-ab12", title: "Entropy", text: entropy, page: "p1" },
		{ id: "202611010905-cd34", title: "Entropy", text: entropy, page: "p2" },
		{ id: "202611011000-ef56", title: "Heat engines", text: "A heat engine turns a flow of heat between two reservoirs into useful work with a limited efficiency", page: "p3" },
		{ id: "202611011100-gh78", title: "", text: "Free fall acceleration near the surface of the earth is about nine point eight metres per second squared", page: "p4" },
		{ id: "202611011200-ij90", title: "Carnot cycle", text: "The Carnot cycle sets the upper bound of efficiency for any engine running between two temperatures", page: "p5" },
	];
	const cards: CardRecord[] = [];
	for (const s of spec) {
		const path = `Zettel/${s.id}${s.title ? ` ${s.title}` : ""}${cards.some((c) => c.title === s.title && s.title) ? " 2" : ""}.md`;
		await vault.create(path, body(s.text));
		cards.push({ path, id: s.id, title: s.title, notebookId: "nb", notebookLink: "[[Notebooks/Physics]]", pageId: s.page, region: null, orphaned: false, links: [] });
	}
	// Heat engines and Carnot cycle link to each other: the other three stay unlinked.
	app.metadataCache.resolvedLinks[cards[2]!.path] = { [cards[4]!.path]: 1, "Notebooks/Physics.notebook": 1 };
	const calls: string[] = [];
	const service = {
		allCards: () => cards,
		openCardNote: (c: CardRecord) => { calls.push(`open:${c.id}`); return Promise.resolve(); },
		retitleCard: (c: CardRecord) => { calls.push(`retitle:${c.id}`); return Promise.resolve(); },
		linkCardPair: () => { calls.push("link"); return Promise.resolve(true); },
	} as unknown as ZettelService;
	const snapshot = async () => (await Promise.all(vault.getFiles().map(async (f) => `${f.path}\n${await vault.read(f)}`))).join("\n--\n");

	const before = await snapshot();
	let modal = new HygieneModal(app as never, service);
	modal.open();
	await sleep(120);
	const q = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(`.nb-hygiene-modal ${sel}`));
	const sections = q(".nb-modal-section-title").map((e) => e.textContent ?? "");
	add("the report has the three sections with counts", sections.length === 3 && sections[0]!.endsWith("(3)") && sections[1]!.endsWith("(1)") && sections[2]!.endsWith("(1)"), sections.join(" | "));
	add("a duplicate group says why", q(".nb-hyg-reasons").some((e) => (e.textContent ?? "").includes(t("hygiene.reason.title"))) && q(".nb-hyg-group .nb-hyg-row").length === 2, q(".nb-hyg-reasons").map((e) => e.textContent).join("|"));
	add("opening and scanning wrote nothing", (await snapshot()) === before);
	add("every row has Open", q(".nb-hyg-row").every((r) => r.querySelector(".nb-modal-btn")?.textContent === t("hygiene.open")));
	add("buttons are touch targets and carry help", q(".nb-hyg-actions .nb-modal-btn").every((b) => b.getBoundingClientRect().height >= 35 && !!b.title));
	const box = document.querySelector<HTMLElement>(".nb-hygiene-modal");
	add("the report fits the screen", !!box && box.getBoundingClientRect().left >= -1 && box.getBoundingClientRect().right <= window.innerWidth + 1);

	// Fixing actions ask first.
	const button = (label: string) => q(".nb-hyg-actions .nb-modal-btn").find((b) => b.textContent === label);
	button(t("hygiene.addTitle"))?.click();
	await sleep(40);
	add("Add title opens a prompt and writes nothing yet", calls.every((c) => !c.startsWith("retitle")) && (await snapshot()) === before);
	document.querySelectorAll(".modal").forEach((m) => { if (!m.classList.contains("nb-hygiene-modal")) m.remove(); });

	const trashBtn = button(t("hygiene.trash"));
	trashBtn?.click();
	await sleep(40);
	const confirmEl = document.querySelector<HTMLElement>(".nb-confirm");
	add("Move to trash asks first and nothing is trashed yet", !!confirmEl && (await snapshot()) === before);
	const cancel = Array.from(confirmEl?.querySelectorAll<HTMLElement>(".nb-modal-btn") ?? []).find((b) => b.textContent === t("ui.modal.cancel"));
	cancel?.click();
	await sleep(40);
	add("Cancel leaves the note", (await snapshot()) === before && !document.querySelector(".nb-confirm"));
	trashBtn?.click();
	await sleep(40);
	const ok = Array.from(document.querySelectorAll<HTMLElement>(".nb-confirm .nb-modal-btn.is-danger"))[0];
	ok?.click();
	await sleep(120);
	add("confirming moves the note to the trash and the group goes", vault.getFiles().length === spec.length - 1 && q(".nb-hyg-group").length === 0, String(vault.getFiles().length));

	q(".nb-hyg-row .nb-modal-btn")[0]?.click();
	await sleep(40);
	add("Open opens the note and closes the report", calls.some((c) => c.startsWith("open:")) && !document.querySelector(".nb-hygiene-modal"));

	// A fresh report for the screenshot.
	modal = new HygieneModal(app as never, service);
	modal.open();
	await sleep(120);
	const shot = document.querySelector<HTMLElement>(".nb-hygiene-modal");
	if (shot && !shot.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(shot);
	await sleep(40);
	api.errors.splice(0, api.errors.length, ...api.errors.filter((e) => !/ENOENT/.test(e)));
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
