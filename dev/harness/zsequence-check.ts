/**
 * 0.30 zsequence (roadmap Z7): the card sequence dialog on the `doc=zsequence` scenario (npm run harness:check). Checked on a small
 * numbering (1, 1a, 1a1, 1a2, 1b, 2): the dialog of card 1a shows its parent, previous (none), next and the two children, every card
 * row opens that card and closes the dialog, a card with nothing around it says "None" instead of showing an empty control, the
 * follow-up / branch buttons exist only when the dialog was opened from a notebook, and the dialog fits the screen with touch-size
 * targets. The dialog is left open for the screenshot.
 */
import type { CardRecord } from "../../src/zettel/card-content";
import { neighbours } from "../../src/zettel/sequence";
import { SequenceModal, type SequenceInfo } from "../../src/zettel/sequence-view";
import { t } from "../../src/i18n";
import { App } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface ZsequenceCheckApi {
	errors: string[];
	notices: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export async function checkZsequence(api: ZsequenceCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const app = new App();
	const spec: Array<[string, string]> = [["1", "Energy"], ["1a", "Work and heat"], ["1a1", "First law"], ["1a2", "Second law"], ["1b", "Power"], ["2", "Waves"]];
	const cards: CardRecord[] = spec.map(([id, title], i) => ({
		path: `Zettelkasten/${id} ${title}.md`, id, title, notebookId: "nb", notebookLink: "[[Notebooks/Physics]]", pageId: `p${i + 1}`, region: null, orphaned: false, links: [],
	}));
	const byId = new Map(cards.map((c) => [c.id, c]));
	const infoOf = (id: string): SequenceInfo => {
		const near = neighbours(id, byId.keys());
		const get = (x: string | null) => (x ? byId.get(x) ?? null : null);
		return { card: byId.get(id)!, parent: get(near.parent), previous: get(near.previous), next: get(near.next), children: near.children.map((c) => byId.get(c)!) };
	};
	const opened: string[] = [];
	const made: string[] = [];
	const q = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(`.nb-sequence-modal ${sel}`));
	const buttonsOf = () => q(".nb-modal-btn").map((el) => ({ el, label: el.querySelector(".nb-modal-btn-label")?.textContent ?? "" }));
	const titles = () =>q(".nb-modal-section-title").map((e) => e.textContent ?? "");

	let modal = new SequenceModal(app as never, infoOf("1a"), { open: (c) => { opened.push(c.id); }, create: (k) => { made.push(k); } });
	modal.open();
	await sleep(120);
	add("the dialog has parent, previous, next and children sections", titles().join("|") === [t("sequence.parent"), t("sequence.previous"), t("sequence.next"), `${t("sequence.children")} (2)`].join("|"), titles().join("|"));
	const rows = q(".nb-seq-row").map((r) => r.querySelector(".nb-modal-row-label")?.textContent ?? "");
	add("it lists the parent, the next card and both children as rows", rows.length === 4 && rows[0]!.startsWith("1 ") && rows[1]!.startsWith("1b") && rows[2]!.startsWith("1a1") && rows[3]!.startsWith("1a2"), rows.join("|"));
	add("a card with no previous one says None, without a control", q(".nb-modal-note").some((n) => n.textContent === t("sequence.none")) && q(".nb-seq-section").length === 4);
	add("every row is a touch target with help and a label", q(".nb-seq-row").every((r) => r.getBoundingClientRect().height >= 44 && !!r.title && !!r.getAttribute("aria-label")));
	const buttons = buttonsOf().map((b) => b.label);
	add("a dialog opened from a notebook offers follow-up and branch", buttons.includes(t("sequence.newFollowUp")) && buttons.includes(t("sequence.newBranch")) && buttons.includes(t("sequence.close")), buttons.join("|"));
	add("the buttons carry help", buttonsOf().filter((b) => b.label !== t("sequence.close")).every((b) => !!b.el.title));
	const box = document.querySelector<HTMLElement>(".nb-sequence-modal");
	add("the dialog fits the screen", !!box && box.getBoundingClientRect().left >= -1 && box.getBoundingClientRect().right <= window.innerWidth + 1);

	q(".nb-seq-row")[1]?.click();
	await sleep(40);
	add("a row opens that card and closes the dialog", opened.join() === "1b" && !document.querySelector(".nb-sequence-modal"), opened.join());

	modal = new SequenceModal(app as never, infoOf("1a"), { open: (c) => { opened.push(c.id); }, create: (k) => { made.push(k); } });
	modal.open();
	await sleep(120);
	buttonsOf().find((b) => b.label === t("sequence.newBranch"))?.el.click();
	await sleep(40);
	add("Branch starts a branch card and closes the dialog", made.join() === "branch" && !document.querySelector(".nb-sequence-modal"), made.join());

	modal = new SequenceModal(app as never, infoOf("2"), { open: (c) => { opened.push(c.id); } });
	modal.open();
	await sleep(120);
	add("opened outside a notebook there are no creation buttons", buttonsOf().map((b) => b.label).join("|") === t("sequence.close"), buttonsOf().map((b) => b.label).join("|"));
	add("a card with no children says None and its previous card is shown", q(".nb-seq-row").length === 1 && q(".nb-modal-note").length === 3, `${q(".nb-seq-row").length} rows`);
	modal.close();
	await sleep(40);

	// A fresh dialog for the screenshot.
	modal = new SequenceModal(app as never, infoOf("1a"), { open: (c) => { opened.push(c.id); }, create: (k) => { made.push(k); } });
	modal.open();
	await sleep(120);
	const shot = document.querySelector<HTMLElement>(".nb-sequence-modal");
	if (shot && !shot.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(shot);
	await sleep(40);
	api.errors.splice(0, api.errors.length, ...api.errors.filter((e) => !/ENOENT/.test(e)));
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
