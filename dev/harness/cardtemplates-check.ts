/**
 * 0.29 cardtemplates (Z9): the card template picker in the New card dialog and the template manager, in the browser harness
 * (`doc=cardtemplates`, HARNESS_DOC=cardtemplates npm run harness:check). The real CardModal and CardTemplatesModal are driven
 * with synthetic taps: layout (no sideways scroll, 40 px targets, no Obsidian default button look) and that every control does
 * what it says. `cardtemplatesShot` leaves each surface open for the screenshots.
 */
import type { App } from "./obsidian-stub";
import { CardModal, type CardAnswer } from "../../src/zettel/modals";
import { CardTemplatesModal } from "../../src/zettel/card-template-ui";
import { allTemplates } from "../../src/zettel/card-templates";
import type { CustomCardTemplate } from "../../src/zettel/card-template-settings";
import { en } from "../../src/i18n/en";
import type { CheckResult } from "./reading-check";
import { obsidianStyledButtons } from "./library-check";

export interface CardtemplatesApi {
	app: App;
	errors: string[];
	notices: string[];
}

export type CardtemplatesState = "picker" | "picker-custom" | "manager" | "manager-empty";

const frames = (n = 2) => new Promise<void>((resolve) => {
	let left = n;
	const step = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(step));
	window.requestAnimationFrame(step);
});

function tap(el: Element | null | undefined): void {
	if (!el) throw new Error("nothing to tap");
	const r = el.getBoundingClientRect();
	const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerType: "touch", isPrimary: true, pointerId: 9 };
	el.dispatchEvent(new PointerEvent("pointerdown", at));
	el.dispatchEvent(new PointerEvent("pointerup", at));
	(el as HTMLElement).click();
}

const MINE: CustomCardTemplate[] = [
	{ id: "custom-1", name: "Meeting idea", type: "fleeting", tags: ["meeting"], sections: ["What was said", "What I will do", "Seen on {{date}}"] },
	{ id: "custom-2", name: "Paper note", type: "literature", tags: [], sections: ["Claim", "Evidence"] },
];

let open: { close(): void; modalEl: HTMLElement } | null = null;
let backdrop: HTMLElement | null = null;

function closeAll(): void {
	open?.close();
	open = null;
	backdrop?.remove();
	backdrop = null;
}

function show(m: { open(): void; modalEl: HTMLElement; close(): void }): void {
	closeAll();
	m.open();
	backdrop = document.body.createDiv({ cls: "harness-modal-container" });
	backdrop.appendChild(m.modalEl);
	open = m;
}

const templates = (custom: readonly CustomCardTemplate[]) => allTemplates((k) => en[k], custom);

function cardDialog(api: CardtemplatesApi, custom: readonly CustomCardTemplate[], done: (a: CardAnswer | null) => void): CardModal {
	const dlg = new CardModal(api.app as never, { luhmann: false, preview: null, templates: templates(custom) }, done);
	show(dlg);
	return dlg;
}

function managerDialog(api: CardtemplatesApi, initial: CustomCardTemplate[], saved: CustomCardTemplate[][]): CardTemplatesModal {
	const dlg = new CardTemplatesModal({
		app: api.app as never,
		get: () => initial,
		set: (list) => {
			saved.push(JSON.parse(JSON.stringify(list)) as CustomCardTemplate[]);
			return Promise.resolve();
		},
	});
	show(dlg);
	return dlg;
}

/** Sets a surface up for a screenshot. */
export async function cardtemplatesShot(api: CardtemplatesApi, state: CardtemplatesState): Promise<void> {
	if (state === "picker" || state === "picker-custom") {
		const dlg = cardDialog(api, state === "picker-custom" ? MINE : [], () => undefined);
		await frames(2);
		tap(dlg.modalEl.querySelector<HTMLElement>('.nb-zk-templates [data-id="quote"]'));
	} else {
		managerDialog(api, state === "manager" ? MINE.map((c) => ({ ...c })) : [], []);
	}
	await frames(3);
	window.scrollTo(0, 0);
}

export async function checkCardtemplates(api: CardtemplatesApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		// --- picker ---
		let answer: CardAnswer | null | undefined;
		const dlg = cardDialog(api, MINE, (a) => (answer = a));
		await frames(3);
		const el = dlg.modalEl;
		const tiles = [...el.querySelectorAll<HTMLElement>(".nb-zk-templates .nb-zk-type")];
		add("the picker has a blank tile, the four built-in templates and the custom ones", tiles.map((x) => x.dataset.id).join() === "blank,concept,question,quote,definition,custom-1,custom-2", tiles.map((x) => x.dataset.id).join());
		add("it is a radio group with blank selected", el.querySelector(".nb-zk-templates")?.getAttribute("role") === "radiogroup" && tiles[0]?.getAttribute("aria-checked") === "true");
		add("the dialog still has its title, type, source and tag fields", el.querySelectorAll(".nb-zk-input").length === 3 && el.querySelectorAll(".nb-zk-types .nb-zk-type").length === 6);
		const small = [...el.querySelectorAll<HTMLElement>("button")].filter((b) => {
			const r = b.getBoundingClientRect();
			return r.width > 0 && (r.height < 39.5 || r.width < 39.5);
		});
		add("every target is at least 40 px", small.length === 0, small.map((b) => b.className).join(", "));
		add("no button shows Obsidian's default button look", obsidianStyledButtons(el).length === 0);
		add("nothing overflows sideways", el.scrollWidth <= el.clientWidth + 1, `${el.scrollWidth} > ${el.clientWidth}`);

		tap(tiles.find((x) => x.dataset.id === "quote"));
		await frames(2);
		const typeTiles = [...el.querySelectorAll<HTMLElement>(".nb-zk-types:not(.nb-zk-templates) .nb-zk-type")];
		add("choosing quote selects it and preselects the literature type", tiles.find((x) => x.dataset.id === "quote")?.getAttribute("aria-checked") === "true" && typeTiles.find((x) => x.dataset.id === "literature")?.getAttribute("aria-checked") === "true");
		tap(typeTiles.find((x) => x.dataset.id === "fleeting"));
		await frames(2);
		add("the type stays the person's choice afterwards", typeTiles.find((x) => x.dataset.id === "fleeting")?.getAttribute("aria-checked") === "true");
		const create = [...el.querySelectorAll<HTMLElement>(".nb-zk-footer .mod-cta")][0];
		tap(create);
		await frames(2);
		add("Create returns the template id and the chosen type", answer?.template === "quote" && answer.type === "fleeting", JSON.stringify(answer));
		closeAll();

		const plain = cardDialog(api, [], () => undefined);
		await frames(2);
		add("with no templates passed there is no picker", plain.modalEl.querySelector(".nb-zk-templates") === null || plain.modalEl.querySelectorAll(".nb-zk-templates .nb-zk-type").length === 5);
		closeAll();

		// --- manager ---
		const saved: CustomCardTemplate[][] = [];
		const last = (): CustomCardTemplate[] | undefined => saved[saved.length - 1];
		const mgr = managerDialog(api, MINE.map((c) => ({ ...c })), saved);
		await frames(3);
		const mel = mgr.modalEl;
		add("the manager lists four built-in templates and the custom ones", mel.querySelectorAll(".nb-tpl-row.is-builtin").length === 4 && mel.querySelectorAll(".nb-tpl-edit").length === 2);
		const msmall = [...mel.querySelectorAll<HTMLElement>("button")].filter((b) => {
			const r = b.getBoundingClientRect();
			return r.width > 0 && (r.height < 39.5 || r.width < 39.5);
		});
		add("every manager target is at least 40 px", msmall.length === 0, msmall.map((b) => b.className).join(", "));
		add("no manager button shows Obsidian's default button look", obsidianStyledButtons(mel).length === 0);
		add("the manager does not overflow sideways", mel.scrollWidth <= mel.clientWidth + 1, `${mel.scrollWidth} > ${mel.clientWidth}`);

		tap(mel.querySelectorAll<HTMLElement>(".nb-tpl-row.is-builtin .nb-icon-btn")[2]);
		await frames(2);
		add("copying a built-in template adds it to yours and saves", mel.querySelectorAll(".nb-tpl-edit").length === 3 && last()?.[last()!.length - 1]?.name === "Quote" && last()?.[last()!.length - 1]?.sections.length === 4, JSON.stringify(last()));

		const first = mel.querySelector<HTMLElement>(".nb-tpl-edit")!;
		const area = first.querySelector<HTMLTextAreaElement>("textarea")!;
		area.value = "One\n\n  Two  \n# Three";
		area.dispatchEvent(new Event("input", { bubbles: true }));
		area.dispatchEvent(new Event("change", { bubbles: true }));
		await frames(2);
		add("editing the areas saves them one heading per line", JSON.stringify(last()?.[0]?.sections) === JSON.stringify(["One", "Two", "Three"]), JSON.stringify(last()?.[0]?.sections));

		const countBefore = last()!.length;
		const del = first.querySelector<HTMLElement>(".nb-tpl-tools button")!;
		tap(del);
		await frames(2);
		add("the first tap on Delete asks again and deletes nothing", mel.querySelectorAll(".nb-tpl-edit").length === 3 && last()!.length === countBefore);
		tap(mel.querySelector<HTMLElement>(".nb-tpl-edit .nb-tpl-tools button"));
		await frames(2);
		add("the second tap deletes it and saves", mel.querySelectorAll(".nb-tpl-edit").length === 2 && last()!.length === countBefore - 1);

		tap([...mel.querySelectorAll<HTMLElement>(".nb-modal-foot button")].find((b) => b.textContent?.includes("Add template")));
		await frames(2);
		add("a new template without a name is not saved yet", mel.querySelectorAll(".nb-tpl-edit").length === 3 && last()!.length === countBefore - 1);
		closeAll();

		await cardtemplatesShot(api, "picker");
		closeAll();
		return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio, width: window.innerWidth } };
	} catch (e) {
		throw new Error(`${(e as Error).message} (after: ${results[results.length - 1]?.name ?? "start"})`);
	}
}

/** The harness entries of this check (assigned onto `window.harness`). */
export function cardtemplatesApi(api: CardtemplatesApi): Record<string, unknown> {
	const guard = async <T>(run: () => Promise<T>) => {
		try {
			return JSON.parse(JSON.stringify(await run())) as unknown;
		} catch (e) {
			return { ok: false, results: [], errors: [`cardtemplates check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
		}
	};
	return {
		checkCardtemplates: () => guard(() => checkCardtemplates(api)),
		cardtemplatesShot: (state: CardtemplatesState) => cardtemplatesShot(api, state),
		cardtemplatesStates: ["picker", "picker-custom", "manager", "manager-empty"],
		closeCardtemplates: () => closeAll(),
	};
}
