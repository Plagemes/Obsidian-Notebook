/**
 * Smoke check of the navigation features (npm run harness:check): the fast scrollbar (roadmap 50) appears on a scroll
 * and drags through the notebook with a bubble that draws no thumbnail per move; Back/Forward (roadmap 18) go through
 * the jumps it records; the status bar item (roadmap O15) shows the page and save state. Driven through the real view.
 */

import type { NavController } from "../../src/view/nav-controller";
import type { HarnessView } from "./harness-types";

export interface NavCheckApi {
	/** The notebook view (a `HarnessView`). */
	view: unknown;
	nav: NavController;
	stage: () => HTMLElement;
	statusBarEl: HTMLElement;
	statusBarClicks: () => number;
	strokeCount: () => number;
	frames: (n: number) => Promise<void>;
	closeAll: () => Promise<void>;
}

export async function checkNavigation(api: NavCheckApi, add: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const { nav, stage, statusBarEl, strokeCount, frames } = api;
	const v = api.view as HarnessView;
	const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	await api.closeAll();
	const pagesBefore = v.session.doc.pages.length;
	const total = Math.max(pagesBefore, 8);
	for (let i = pagesBefore; i < total; i++) v.addPage();
	nav.history.clear();
	v.scrollToPage(3);
	await frames(3);

	const bar = v.scrollbar.el;
	const thumb = bar.querySelector(".notebook-scrollbar-thumb") as HTMLElement;
	const bubble = bar.querySelector(".notebook-scrollbar-bubble") as HTMLElement;
	add("scrollbar: it shows after a scroll, with a thumb of at least 44 px",
		bar.classList.contains("is-visible") && !bar.classList.contains("notebook-hidden") && thumb.getBoundingClientRect().height >= 44,
		`visible ${bar.classList.contains("is-visible")}, thumb ${Math.round(thumb.getBoundingClientRect().height)} px`);
	const tr = thumb.getBoundingClientRect();
	const track = bar.getBoundingClientRect();
	const mid = tr.top + tr.height / 2;
	add("scrollbar: the thumb sits at the right edge of the page area, inside its track",
		tr.right <= stage().getBoundingClientRect().right + 1 && tr.top >= track.top - 1 && tr.bottom <= track.bottom + 1,
		`thumb ${Math.round(tr.left)},${Math.round(tr.top)} track ${Math.round(track.top)}-${Math.round(track.bottom)}`);

	let drawn = 0;
	const original = v.thumbnail;
	v.thumbnail = (...a: unknown[]) => {
		drawn++;
		return original.apply(v, a);
	};
	const strokes = strokeCount();
	try {
		const ev = (type: string, y: number) => new PointerEvent(type, {
			bubbles: true, cancelable: true, composed: true, pointerId: 91, pointerType: "touch", isPrimary: true,
			clientX: tr.left + 10, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1,
		});
		thumb.dispatchEvent(ev("pointerdown", mid));
		add("scrollbar: grabbing the thumb shows the bubble", bubble.classList.contains("is-shown") && bar.classList.contains("is-dragging"), "");
		for (let i = 1; i <= 40; i++) thumb.dispatchEvent(ev("pointermove", mid + ((track.bottom - 2 - mid) * i) / 40));
		const label = bubble.querySelector(".notebook-scrollbar-label")?.textContent ?? "";
		add("scrollbar: dragging to the end shows the last page in the bubble and scrolls there",
			label === `Page ${total} of ${total}` && v.currentPage() === total - 1, `"${label}", page ${v.currentPage() + 1}`);
		add("scrollbar: no thumbnail is drawn per move", drawn === 0, `${drawn} drawn during 40 moves`);
		const img = bubble.querySelector("img") as HTMLImageElement;
		for (let i = 0; i < 80 && !img.getAttribute("src"); i++) await wait(50);
		add("scrollbar: the preview is drawn once the thumb rests", !!img.getAttribute("src") && drawn === 1, `${drawn} drawn, src ${img.getAttribute("src") ? "set" : "empty"}`);
		thumb.dispatchEvent(ev("pointerup", track.bottom - 2));
		await frames(2);
		add("scrollbar: letting go hides the bubble and draws no stroke",
			!bubble.classList.contains("is-shown") && !bar.classList.contains("is-dragging") && strokeCount() === strokes, `bubble ${bubble.classList.contains("is-shown")}`);
	} finally {
		v.thumbnail = original;
	}

	add("history: the drag is one jump (Back is possible, Forward is not)", nav.canBack && !nav.canForward, `back ${nav.canBack}, forward ${nav.canForward}`);
	const ctx = v.uiContext().nav;
	add("history: the interface context offers Back", ctx?.back === true && ctx?.forward === false, JSON.stringify(ctx));
	// 0.13 ds-notebook: 44 px slots leave two quick slots on a short landscape phone (740 px), where Back stays in "All actions"; from three slots on it is a quick slot.
	if (v.toolbar.quickIds.length >= 3) add("history: Back is a quick slot of the toolbar", v.toolbar.quickIds.includes("nav-back"), v.toolbar.quickIds.join(","));
	v.runAction("nav-back");
	for (let i = 0; i < 40 && v.currentPage() !== 3; i++) await wait(25);
	add("history: Back returns to the page the reader left", v.currentPage() === 3, `page ${v.currentPage() + 1}`);
	add("history: going back records no new jump (Forward is now possible)", nav.canForward && !nav.canBack, `back ${nav.canBack}, forward ${nav.canForward}`);
	v.runAction("nav-forward");
	for (let i = 0; i < 40 && v.currentPage() !== total - 1; i++) await wait(25);
	add("history: Forward goes to the page jumped to", v.currentPage() === total - 1, `page ${v.currentPage() + 1}`);
	v.jumpToPage(1);
	await frames(2);
	add("history: Go to page number is a jump too", nav.canBack && v.currentPage() === 1, `back ${nav.canBack}, page ${v.currentPage() + 1}`);
	v.goToRelativePage(1);
	await frames(3);
	const length = nav.history.length;
	v.goToRelativePage(1);
	await frames(3);
	add("history: turning pages one by one records nothing", nav.history.length === length, `${length} → ${nav.history.length}`);

	// The status bar item (desktop): the page and save state of the view; a click opens the page panel.
	v.scrollToPage(4);
	await frames(3);
	const text = statusBarEl.textContent ?? "";
	add("status bar: shows the page in view and the save state",
		new RegExp(`^p\\. 5/${total} · \\S`).test(text) && !statusBarEl.classList.contains("notebook-hidden"), `"${text}"`);
	if (v.pageNav.open) v.runAction("toggle-pages-panel");
	const clicks = api.statusBarClicks();
	statusBarEl.click();
	add("status bar: a click opens the page panel", api.statusBarClicks() === clicks + 1 && v.pageNav.open, `panel ${v.pageNav.open}`);
	if (v.pageNav.open) v.runAction("toggle-pages-panel");

	// The setting turns the scrollbar off.
	v.host.settings.fastScrollbar = false;
	v.applySettings(v.host.settings);
	add("scrollbar: the setting hides it", bar.classList.contains("notebook-hidden"), "");
	v.host.settings.fastScrollbar = true;
	v.applySettings(v.host.settings);

	// Back to the document as it was.
	for (let i = pagesBefore; i < total; i++) v.undo();
	nav.history.clear();
	// The screenshot of the scenario looks at the first page.
	v.scrollToPage(0);
	await frames(3);
}
