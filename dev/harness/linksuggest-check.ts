/**
 * 0.30 linksuggest (Z5): the "Cards to link" part of the New card dialog, in the browser harness (`doc=linksuggest`,
 * HARNESS_DOC=linksuggest npm run harness:check). The real CardModal is driven with synthetic taps and typing against a small
 * fake slip-box: suggestions follow what is typed, one tap chooses, the setting turns it off, and the chosen cards come back
 * with the answer (the service links them in the task that makes the note). `linksuggestShot` leaves each state open for the screenshots.
 */
import type { App } from "./obsidian-stub";
import { CardModal, type CardAnswer } from "../../src/zettel/modals";
import { setLinkSuggestHost } from "../../src/zettel/link-suggest-ui";
import type { CardRecord } from "../../src/zettel/card-content";
import type { CheckResult } from "./reading-check";
import { obsidianStyledButtons } from "./library-check";

export interface LinksuggestApi {
	app: App;
	errors: string[];
	notices: string[];
}

export type LinksuggestState = "typed" | "chosen" | "empty";

const frames = (n = 2) => new Promise<void>((resolve) => {
	let left = n;
	const step = () => (--left <= 0 ? resolve() : window.requestAnimationFrame(step));
	window.requestAnimationFrame(step);
});
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function tap(el: Element | null | undefined): void {
	if (!el) throw new Error("nothing to tap");
	const r = el.getBoundingClientRect();
	const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerType: "touch", isPrimary: true, pointerId: 9 };
	el.dispatchEvent(new PointerEvent("pointerdown", at));
	el.dispatchEvent(new PointerEvent("pointerup", at));
	(el as HTMLElement).click();
}

function typeInto(el: HTMLInputElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

const CARDS: Array<{ id: string; title: string; tags: string[] }> = [
	{ id: "20260101-0001", title: "Spaced repetition schedules reviews", tags: ["memory", "learning"] },
	{ id: "20260102-0002", title: "Memory palace technique", tags: ["memory"] },
	{ id: "20260103-0003", title: "Retrieval practice beats rereading", tags: ["learning"] },
	{ id: "20260104-0004", title: "Cooking pasta", tags: ["food"] },
];

let open: { close(): void; modalEl: HTMLElement } | null = null;
let backdrop: HTMLElement | null = null;

function closeAll(): void {
	open?.close();
	open = null;
	backdrop?.remove();
	backdrop = null;
}

async function seed(api: LinksuggestApi, on: boolean, count = 4): Promise<CardRecord[]> {
	const records: CardRecord[] = [];
	let n = 0;
	for (const c of CARDS) {
		const path = `Zettelkasten/${c.id} ${c.title}.md`;
		if (!api.app.vault.getFileByPath(path)) await api.app.vault.create(path, "x");
		api.app.metadataCache.caches.set(path, { frontmatter: { "zettel-id": c.id, title: c.title, tags: c.tags } });
		const file = api.app.vault.getFileByPath(path);
		if (file) file.stat.mtime = 1000 + n;
		n++;
		records.push({ path, id: c.id, title: c.title, notebookId: "nb", notebookLink: "", pageId: `p${n}`, region: null, orphaned: false, links: [] });
	}
	setLinkSuggestHost({
		settings: () => ({ zettelLinkSuggest: on, zettelLinkSuggestCount: count }),
		service: () => ({ allCards: () => records }),
	});
	return records;
}

function cardDialog(api: LinksuggestApi, done: (a: CardAnswer | null) => void): CardModal {
	closeAll();
	const dlg = new CardModal(api.app as never, { luhmann: false, preview: null }, done);
	dlg.open();
	backdrop = document.body.createDiv({ cls: "harness-modal-container" });
	backdrop.appendChild(dlg.modalEl);
	open = dlg;
	return dlg;
}

const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".nb-zk-suggest-row")];

/** Sets a surface up for a screenshot. */
export async function linksuggestShot(api: LinksuggestApi, state: LinksuggestState): Promise<void> {
	await seed(api, true);
	const dlg = cardDialog(api, () => undefined);
	await frames(2);
	const inputs = dlg.modalEl.querySelectorAll<HTMLInputElement>(".nb-zk-input");
	if (state !== "empty") {
		typeInto(inputs[0]!, "Memory and learning");
		typeInto(inputs[2]!, "memory, learning");
		await wait(450);
		if (state === "chosen") tap(rows(dlg.modalEl)[0]);
	}
	await frames(3);
	window.scrollTo(0, 0);
}

export async function checkLinksuggest(api: LinksuggestApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		await seed(api, true, 2);
		let answer: CardAnswer | null | undefined;
		const dlg = cardDialog(api, (a) => (answer = a));
		await frames(3);
		const el = dlg.modalEl;
		add("the dialog has the Cards to link field", el.querySelector(".nb-zk-suggest") !== null);
		add("an empty form lists no card, only a hint", rows(el).length === 0 && el.querySelector(".nb-zk-suggest-empty") !== null);
		const inputs = el.querySelectorAll<HTMLInputElement>(".nb-zk-input");
		typeInto(inputs[2]!, "memory");
		await wait(100);
		add("suggestions wait for the debounce", rows(el).length === 0, String(rows(el).length));
		await wait(400);
		const ids = rows(el).map((r) => r.querySelector(".nb-zk-suggest-reason")?.textContent ?? "");
		add("a shared tag lists the two memory cards, newest first", ids.length === 2 && ids[0]!.startsWith(CARDS[1]!.id) && ids[1]!.startsWith(CARDS[0]!.id), ids.join(" | "));
		add("each row says why", ids.every((x) => x.includes("#memory")), ids.join(" | "));
		const small = [...el.querySelectorAll<HTMLElement>("button")].filter((b) => {
			const r = b.getBoundingClientRect();
			return r.width > 0 && (r.height < 39.5 || r.width < 39.5);
		});
		add("every target is at least 40 px", small.length === 0, small.map((b) => b.className).join(", "));
		add("no button shows Obsidian's default button look", obsidianStyledButtons(el).length === 0);
		add("nothing overflows sideways", el.scrollWidth <= el.clientWidth + 1, `${el.scrollWidth} > ${el.clientWidth}`);

		typeInto(inputs[2]!, "memory, learning");
		typeInto(inputs[0]!, "Memory techniques");
		await wait(450);
		add("the count setting limits the list", rows(el).length === 2, String(rows(el).length));
		tap(rows(el)[0]);
		await frames(2);
		add("one tap chooses a card", rows(el)[0]?.getAttribute("aria-pressed") === "true" && rows(el)[0]?.classList.contains("is-active") === true);
		tap(rows(el)[0]);
		await frames(2);
		add("a second tap takes it back", rows(el).every((r) => r.getAttribute("aria-pressed") === "false"));
		tap(rows(el)[0]);
		await frames(2);

		tap(el.querySelector<HTMLElement>(".nb-zk-footer .mod-cta"));
		await frames(2);
		add("Create returns the answer", answer?.title === "Memory techniques", JSON.stringify(answer?.title));
		// review Z1: the chosen card travels with the answer; the service links it in the task that makes the note (no watcher)
		add("the answer carries the chosen card, to link to the note made from it", answer?.links?.length === 1 && CARDS.some((c) => c.id === answer?.links?.[0]?.id), JSON.stringify(answer?.links?.map((c) => c.id)));
		closeAll();

		await seed(api, false);
		const off = cardDialog(api, () => undefined);
		await frames(2);
		add("with the setting off the dialog has no suggestions", off.modalEl.querySelector(".nb-zk-suggest") === null);
		closeAll();

		await linksuggestShot(api, "chosen");
		closeAll();
		return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio, width: window.innerWidth } };
	} catch (e) {
		throw new Error(`${(e as Error).message} (after: ${results[results.length - 1]?.name ?? "start"})`);
	}
}

/** The harness entries of this check (assigned onto `window.harness`). */
export function linksuggestApi(api: LinksuggestApi): Record<string, unknown> {
	const guard = async <T>(run: () => Promise<T>) => {
		try {
			return JSON.parse(JSON.stringify(await run())) as unknown;
		} catch (e) {
			return { ok: false, results: [], errors: [`linksuggest check: ${(e as Error).stack ?? String(e)}`], notices: [], env: {} };
		}
	};
	return {
		checkLinksuggest: () => guard(() => checkLinksuggest(api)),
		linksuggestShot: (state: LinksuggestState) => linksuggestShot(api, state),
		linksuggestStates: ["typed", "chosen", "empty"],
		closeLinksuggest: () => closeAll(),
	};
}
