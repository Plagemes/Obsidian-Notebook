/**
 * Smoke check of "Move to page…" (0.16, roadmap #78) on the `doc=movesel` notebook (the outline notebook, five pages;
 * npm run harness:check). Selects the ink of page 1 through the real view, opens the picker through the action of the
 * registry, drives it through the DOM (thumbnail cards, "New page after", exact-position chip), moves the selection to
 * page 4 and checks the document, undo and redo, then copies to a new page. It leaves the picker open for the screenshot.
 */
import type { Stroke } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface MoveselCheckApi {
	view: unknown;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface SelectingView extends HarnessView {
	selectItems(pageIndex: number, strokes: Stroke[], elements: never[]): void;
}

export async function checkMovesel(api: MoveselCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as SelectingView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const modal = (): HTMLElement | null => document.querySelector<HTMLElement>(".nb-move-modal");
	const cards = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(".nb-move-modal .nb-map-card"));
	const doc = () => v.session.doc;
	const counts = () => doc().pages.map((p) => p.strokes.length);
	const hostModal = async (): Promise<void> => {
		await frames(3);
		const m = modal();
		if (m && !m.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(m);
		await frames(2);
	};

	const startCounts = counts();
	const first = doc().pages[0]!.strokes.slice(0, 2);
	add("page 1 has ink to move", first.length === 2, `${startCounts.join(",")}`);
	const ids = first.map((s) => s.id);
	v.selectItems(0, first, []);
	await frames(2);

	v.runAction("selection-move-page");
	await hostModal();
	add("the picker opens", modal() !== null);
	add("a card for every other page plus New page", cards().length === doc().pages.length, `${cards().length}`);
	add("the source page is not offered", !cards().some((c) => c.dataset.index === "0"));
	add("New page after is the first card", cards()[0]?.dataset.index === "new");
	add("every card is a 40 px target", cards().every((c) => c.getBoundingClientRect().height >= 40));
	add("cards stay inside the dialog", cards().every((c) => { const r = c.getBoundingClientRect(); const m = modal()!.getBoundingClientRect(); return r.left >= m.left - 1 && r.right <= m.right + 1; }));
	for (let i = 0; i < 40 && cards().some((c) => c.dataset.index !== "new" && !c.querySelector("img")?.getAttribute("src")); i++) await sleep(50);
	add("thumbnails are drawn", cards().filter((c) => c.dataset.index !== "new").every((c) => (c.querySelector("img")?.getAttribute("src") ?? "").startsWith("data:")));
	document.querySelector<HTMLElement>(".nb-move-modal .nb-chip")?.click();
	await frames(1);
	add("the exact-position chip toggles", document.querySelector(".nb-move-modal .nb-chip")?.getAttribute("aria-pressed") === "true");
	document.querySelector<HTMLElement>(".nb-move-modal .nb-chip")?.click();

	const shot = modal();
	// Choose page 4 (index 3).
	cards().find((c) => c.dataset.index === "3")?.click();
	await frames(4);
	const after = counts();
	add("the picker closes", modal() === null);
	add("the strokes left page 1 and joined page 4", after[0] === startCounts[0]! - 2 && after[3] === startCounts[3]! + 2, after.join(","));
	add("with the same ids", ids.every((id) => doc().pages[3]!.strokes.some((s) => s.id === id)));
	add("the toast offers Go to page", api.notices.some((n) => n.includes("page 4")));
	v.undo();
	await frames(2);
	add("one undo puts everything back", counts().join(",") === startCounts.join(","), counts().join(","));
	v.redo();
	await frames(2);
	add("redo moves it again", counts()[3] === startCounts[3]! + 2);
	v.undo();
	await frames(2);

	// Copy to a new page after page 1: one undo removes the page again.
	v.selectItems(0, doc().pages[0]!.strokes.slice(0, 1), []);
	await frames(2);
	v.runAction("selection-copy-page");
	await hostModal();
	cards().find((c) => c.dataset.index === "new")?.click();
	await frames(4);
	add("copy to a new page adds a page with the copy", doc().pages.length === startCounts.length + 1 && doc().pages[1]!.strokes.length === 1 && doc().pages[0]!.strokes.length === startCounts[0], counts().join(","));
	v.undo();
	await frames(2);
	add("one undo removes the new page", doc().pages.length === startCounts.length && counts().join(",") === startCounts.join(","), counts().join(","));

	// Leave the picker open for the screenshot.
	v.selectItems(0, doc().pages[0]!.strokes.slice(0, 2), []);
	await frames(2);
	v.runAction("selection-move-page");
	await hostModal();
	void shot;
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
