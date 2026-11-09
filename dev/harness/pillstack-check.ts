/**
 * Stacking of the floating pills (0.22 review fix, extra item from the integration) on the `doc=pillstack` notebook (the blank
 * "New" notebook with the lecture stub; HARNESS_DOC=pillstack npm run harness:check). Every floating piece the view can show at
 * the same time is put on screen at once: the recent-symbols strip and the "Back to current page" pill (top centre), the
 * "Referenced on" chip (top right), the minimap parked at the bottom left, the colour-filter pill and the lecture-header chip (bottom
 * left). None may overlap another, all stay inside the page area, and the pagerefs list opened over them stays inside too.
 * The screenshot taken after the check (dist/shots/pillstack-<theme>-<device>.png) is the one combined picture.
 */
import { createStroke } from "../../src/model/document";
import { AddStroke } from "../../src/model/history";
import { createMarker } from "../../src/model/markers";
import { WELCOME_KEY } from "../../src/model/welcome-back";
import { freezeStroke } from "../../src/model/serialize";
import type { PageElement } from "../../src/model/types";
import type { HarnessView } from "./harness-types";
import { classNow, lectureStub } from "./lecture-check";
import type { CheckResult } from "./reading-check";

export interface PillstackCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	penStroke: (points: Array<[number, number]>) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface PillstackView extends HarnessView {
	lectureMode: { on: boolean; toggle(): void };
	pageRefs: { shown: readonly { index: number }[]; listOpen: boolean; openList(): void; closeList(): void; sync(): void };
	minimap: { el: HTMLElement; preferences: { corner: string; collapsed: boolean } };
	meaningTools: { choose(index: number | null): void };
	welcomeBack: { offer(doc: HarnessView["document"]): void };
	app: { saveLocalStorage(key: string, data: unknown): void; vault: { create(p: string, data: string): Promise<unknown> }; metadataCache: { caches: Map<string, unknown> } };
	plannerTasks: { reset(): void };
	addPage(): void;
	scrollToPage(index: number, y?: number, animate?: boolean): void;
	host: HarnessView["host"] & {
		settings: HarnessView["host"]["settings"] & {
			lectureHeader: string; plannerTasks: boolean; welcomeBack: boolean; slideBack: boolean; symbolStrip: boolean; symbolCount: number; pageRefs: boolean; minimapMode: string;
			colourMeanings: Array<{ colour: string; label: string }>;
		};
	};
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const text = (id: string, t: string): PageElement => ({ id, type: "text", x: 60, y: 120, width: 420, text: t, fontSize: 22, color: "#1e1e1e" });

/** The floating pieces, by name. */
const PIECES: Array<[string, string]> = [
	["symbols strip", ".notebook-symbol-strip:not(.notebook-hidden)"],
	["back-to-page pill", ".notebook-slide-back"],
	["referenced-on chip", ".notebook-page-refs"],
	["minimap", ".nb-minimap:not(.notebook-hidden)"],
	["colour-filter pill", ".nb-meaning-pill"],
	["lecture-header chip", ".notebook-lecture-header-offer"],
	["lecture-mode chip", ".notebook-lecture-chip"],
	["contextual bar", ".notebook-context-bar:not(.notebook-hidden)"],
	["welcome-back card", ".notebook-welcome-back"],
	["tasks chip", ".notebook-plantasks"],

];

function visible(el: HTMLElement | null): el is HTMLElement {
	return !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
}

const box = (r: DOMRect): string => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
const overlap = (a: DOMRect, b: DOMRect): boolean => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/** Puts every piece on screen at once and returns the view (shared by the check and the screenshot). */
async function prepare(api: PillstackCheckApi): Promise<PillstackView> {
	lectureStub.cls = classNow("Analysis 1");
	await api.open("pillstack");
	const v = api.view as PillstackView;
	const s = v.host.settings;
	s.lectureHeader = "ask";
	s.slideBack = true;
	s.symbolStrip = true;
	s.symbolCount = 6;
	s.pageRefs = true;
	s.minimapMode = "always";
	s.colourMeanings = [{ colour: "#dc2626", label: "Definition" }, { colour: "#1d4ed8", label: "Example" }];
	v.applySettings(s);
	await api.frames(4);
	// A place to come back to: writing in the lecture mode on page 1, then more pages.
	v.lectureMode.toggle();
	await api.frames(3);
	while (v.document.pages.length < 4) v.addPage();
	await api.frames(3);
	v.scrollToPage(0);
	await api.frames(3);
	await api.penStroke([[0.2, 0.3], [0.5, 0.34], [0.7, 0.3]]);
	await sleep(150);
	// A red stroke so the filter has something to filter.
	const first = v.document.pages[0]!;
	v.history.execute(new AddStroke(first.id, freezeStroke(createStroke("#dc2626", 3, [[80, 200, 0.5], [300, 220, 0.5], [420, 200, 0.5]])), first.strokes.length));
	await api.frames(2);
	// A new page during the class: the chip is offered (ask). Pages 1 and 3 link to it.
	v.addPage();
	await sleep(250);
	await api.frames(3);
	const pages = v.document.pages;
	const last = pages[pages.length - 1]!;
	const link = `[[New.notebook#p${pages.length}&id=${last.id}|see the new page]]`;
	// 0.27 plannertasks: the new page is a daily planner page with a task due that day, so its tasks chip joins the stack.
	Object.assign(last, { paper: { kind: "planner-day", spacing: 28 }, elements: [{ id: "ps-title", type: "text", x: 8, y: 8, width: 500, text: "Thursday, 12 March 2026", fontSize: 17, color: "#1f2937" }] });
	await v.app.vault.create("Tasks/Pillstack.md", "- [ ] Hand in the form 📅 2026-03-12").catch(() => undefined);
	v.app.metadataCache.caches.set("Tasks/Pillstack.md", { listItems: [{ task: " " }] });
	v.host.settings.plannerTasks = true;
	v.plannerTasks.reset();
	pages[0]!.elements = [...(pages[0]!.elements ?? []), text("ps-a", `Intro, then ${link}`)];
	pages[2]!.elements = [...(pages[2]!.elements ?? []), text("ps-c", link)];
	v.pageRefs.sync();
	// The minimap goes to the bottom left, the corner the pill and the chip share.
	const body = v.minimap.el.parentElement!.getBoundingClientRect();
	const grip = v.minimap.el.querySelector<HTMLElement>(".nb-minimap-grip");
	if (grip && v.minimap.preferences.corner !== "bl") {
		const g = grip.getBoundingClientRect();
		const fire = (type: string, x: number, y: number) =>
			grip.dispatchEvent(new PointerEvent(type, { pointerId: 43, pointerType: "touch", clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, cancelable: true }));
		fire("pointerdown", g.left + 8, g.top + 8);
		fire("pointermove", body.left + 40, body.bottom - 40);
		fire("pointerup", body.left + 40, body.bottom - 40);
		await api.frames(3);
	}
	v.meaningTools.choose(0);
	await api.frames(3);
	// Away from the written place, on the new page: the back pill shows once the scroll settles.
	v.scrollToPage(pages.length - 1, 0, false);
	await sleep(600);
	// 0.23 welcomeback: the card, offered last (a long absence, a stored place, an open question and a gap), takes the tier below the pills.
	s.welcomeBack = true;
	pages[1]!.elements = [...(pages[1]!.elements ?? []), createMarker("question", 80, 200, { text: "Why does the series converge?" }), createMarker("gap", 80, 400)];
	v.document.position = { page: pages[2]!.id, y: 0, at: new Date().toISOString() };
	v.app.saveLocalStorage(WELCOME_KEY, { [v.document.id]: Date.now() - 20 * 3_600_000 });
	v.welcomeBack.offer(v.document);
	await api.frames(4);
	await api.frames(4);
	return v;
}

/** The view with everything on screen, for the screenshots. */
export async function pillstackShot(api: PillstackCheckApi): Promise<void> {
	await prepare(api);
}

export async function checkPillstack(api: PillstackCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		const v = await prepare(api);
		const body = v.minimap.el.parentElement!;
		const bodyRect = body.getBoundingClientRect();
		const shown = PIECES.map(([name, sel]) => ({ name, el: body.querySelector<HTMLElement>(`:scope > ${sel}`) })).map((p) => ({ ...p, ok: visible(p.el) }));
		for (const p of shown) {
			const r = p.el?.getBoundingClientRect();
			add(`${p.name} is on screen`, p.ok || (p.name === "tasks chip" && bodyRect.width <= 600), // (0.27: on a phone the tasks chip steps aside for the welcome-back card)
			 r ? `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : "missing");
		}
		const rects = shown.filter((p) => p.ok).map((p) => ({ name: p.name, r: p.el!.getBoundingClientRect() }));
		for (const p of rects) {
			add(`${p.name} stays inside the page area`, p.r.left >= bodyRect.left - 1 && p.r.right <= bodyRect.right + 1 && p.r.top >= bodyRect.top - 1 && p.r.bottom <= bodyRect.bottom + 1,
				`${Math.round(p.r.left - bodyRect.left)},${Math.round(p.r.top - bodyRect.top)} ${Math.round(p.r.width)}x${Math.round(p.r.height)} in ${Math.round(bodyRect.width)}x${Math.round(bodyRect.height)}`);
		}
		const clashes: string[] = [];
		for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (overlap(rects[i]!.r, rects[j]!.r)) clashes.push(`${rects[i]!.name} ${box(rects[i]!.r)} / ${rects[j]!.name} ${box(rects[j]!.r)}`);
		add("no two floating pieces overlap", clashes.length === 0, clashes.join("; "));

		// The "Referenced on" list opened over the stack stays inside and clear of the other pieces.
		v.pageRefs.openList();
		await api.frames(3);
		const list = body.querySelector<HTMLElement>(":scope > .notebook-page-refs-list");
		if (visible(list)) {
			const lr = list.getBoundingClientRect();
			add("the opened list stays inside the page area", lr.left >= bodyRect.left - 1 && lr.right <= bodyRect.right + 1 && lr.bottom <= bodyRect.bottom + 1);
			const under = rects.filter((p) => p.name !== "referenced-on chip" && p.name !== "welcome-back card" && p.name !== "tasks chip" && overlap(lr, p.r)).map((p) => p.name);
			add("the opened list covers none of the other pieces", under.length === 0, under.join(", "));
			add("the welcome-back card steps aside while the list is open", !visible(body.querySelector<HTMLElement>(":scope > .notebook-welcome-back")));
			add("the tasks chip steps aside while the list is open", !visible(body.querySelector<HTMLElement>(":scope > .notebook-plantasks")));
		} else add("the referenced-on list opens", false, "no list");
		v.pageRefs.closeList();
		await api.frames(3);
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
