/**
 * Smoke check of the practice strip and the peek on the `doc=practice` notebook (npm run harness:check): a practice copy is
 * made with the model (the dialog needs a real Obsidian), put into the notebook through the view's edit context and linked
 * through the service, and the strip and the peek overlay are then driven through the real view, DOM and renderer.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createStroke } from "../../src/model/document";
import { AddPage, AddStroke } from "../../src/model/history";
import { buildPracticePage, newRecord } from "../../src/model/practice";
import type { CheckResult } from "./reading-check";

export interface PracticeCheckApi {
	view: any;
	app: any;
	service: any;
	frames(n: number): Promise<void>;
	errors: string[];
	notices: string[];
}

const RED = "#dc2626";

export async function checkPractice(api: PracticeCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { view: v, service, frames } = api;
	const vault = api.app.vault;
	const results: CheckResult[] = [];
	const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const banner = (): HTMLElement | null => document.querySelector(".notebook-practice-banner");
	const shown = (): boolean => !!banner() && !banner()!.classList.contains("notebook-hidden");
	const content = (): string => JSON.stringify(v.document.pages);

	// An original page with a red horizontal line (the solution) and a black one (the statement).
	const doc = v.document;
	const original = doc.pages[0];
	const line = (y: number, color: string) => createStroke(color, 6, [[100, y, 0.5], [250, y, 0.5], [400, y, 0.5]]);
	const red = line(300, RED);
	const black = line(500, "#111111");
	v.history.execute(new AddStroke(original.id, black, original.strokes.length));
	v.history.execute(new AddStroke(original.id, red, original.strokes.length));
	v.afterHistoryChange();
	await frames(2);

	// The copy, as "Redo this exercise" makes it, into the notebook in one undo step.
	const spec = { colors: [RED] };
	const copy = buildPracticePage(original, spec, 1);
	const ctx = v.editContext();
	add("the view can be edited from outside", !!ctx);
	ctx.execute(new AddPage(copy.page, 1), 1);
	const linked = await service.write({
		type: "add",
		record: newRecord({ practice: { doc: doc.id, page: copy.page.id }, original: { doc: doc.id, page: original.id }, n: 1, hide: spec }),
	});
	// One sidecar file per device (`practice-<device>.json`); the old shared `practice.json` is never written.
	const sidecars = vault.getFiles().filter((f: { path: string }) => /^Notebooks\/_meta\/practice-[0-9a-f]{8}\.json$/.test(f.path));
	add("the link is written to this device's sidecar", linked === true && sidecars.length === 1 && !vault.getFileByPath("Notebooks/_meta/practice.json"));
	await frames(3);
	await sleep(100);

	add("the copy has the black line and not the red one", copy.page.strokes.length === 1 && copy.hidden === 1 && doc.pages[1] === copy.page);
	add("the strip is shown on the practice page", shown(), banner()?.textContent ?? "no strip");
	add("the strip says which attempt it is and offers peek, original, attempts and the timer",
		(banner()?.textContent ?? "").includes("attempt 1") && banner()!.querySelectorAll("button").length === 4, banner()?.textContent ?? "");

	// The peek: the red line appears over the copy while the button is held, and is gone afterwards.
	const live = (): HTMLCanvasElement => document.querySelector("canvas.notebook-canvas-live:not(.notebook-canvas-wet)") as HTMLCanvasElement;
	const redOnLive = (): boolean => {
		const c = live();
		const r = c.getBoundingClientRect();
		const box = v.layout.boxes[1];
		const vp = v.viewport;
		const dpr = c.width / r.width;
		const x = Math.round((vp.offsetX + (box.x + 250) * vp.scale) * dpr);
		const y = Math.round((vp.offsetY + (box.y + 300) * vp.scale) * dpr);
		const band = Math.ceil(10 * dpr);
		const d = c.getContext("2d")!.getImageData(Math.max(0, x - 2), Math.max(0, y - band), 5, band * 2).data;
		for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 120 && d[i]! > 150 && d[i + 1]! < 110) return true;
		return false;
	};
	add("nothing is drawn over the copy before the peek", !redOnLive());
	const peek = banner()!.querySelector(".notebook-practice-peek") as HTMLButtonElement;
	const before = content();
	peek.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 31, pointerType: "touch", isPrimary: true, button: 0, buttons: 1 }));
	await sleep(120);
	await frames(3);
	add("holding the peek button draws the original's hidden ink over the copy", redOnLive());
	add("the peek is held visually", peek.classList.contains("is-held"));
	add("the peek does not change the notebook", content() === before);
	peek.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 31, pointerType: "touch", isPrimary: true, button: 0 }));
	await frames(3);
	add("letting go removes it", !redOnLive());

	// Peek is gone after a page change too (the button released on another page).
	peek.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 32, pointerType: "touch", isPrimary: true, button: 0, buttons: 1 }));
	await sleep(120);
	v.scrollToPage(0);
	await sleep(300);
	await frames(3);
	add("the strip is hidden on the original page", !shown());
	add("and so is the overlay", !redOnLive());

	// The timer's controls and the attempts list only exist on a linked page; going back shows the strip again.
	v.scrollToPage(1);
	await sleep(300);
	await frames(2);
	add("the strip is back on the practice page", shown());
	const timer = banner()!.querySelector(".notebook-practice-timer") as HTMLButtonElement;
	timer.click();
	await sleep(50);
	const running = (banner()!.querySelector(".notebook-practice-timer") as HTMLElement).classList.contains("is-running");
	add("the timer starts", running);
	await sleep(1100);
	(banner()!.querySelector(".notebook-practice-timer") as HTMLButtonElement).click();
	await sleep(300);
	const stopped = !(banner()!.querySelector(".notebook-practice-timer") as HTMLElement).classList.contains("is-running");
	add("the timer stops and the time is kept with the attempt", stopped && (service.data().attempts[0]?.seconds ?? 0) >= 1, JSON.stringify(service.data().attempts[0]?.seconds));

	// Undoing the page removes the copy; the strip goes with it.
	v.undo();
	await sleep(300);
	await frames(2);
	add("undo removes the practice page in one step", doc.pages.length === 1);
	add("and the strip with it", !shown());

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
