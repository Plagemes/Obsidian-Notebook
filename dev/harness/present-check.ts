/**
 * Smoke check of presentation mode (0.16, roadmap #87) on the `doc=present` notebook (the outline notebook, five pages;
 * npm run harness:check): the command (action registry), the full-screen overlay with one page fitted on black, next and
 * previous by keys, tap zones and swipe, the steps through the states of a drawing before the next page, the laser pointer
 * (pen moves a dot and a trail, nothing is written), "write while presenting", the auto-hiding counter and controls, the
 * exit, and that the document is never changed by any of it. It leaves the presentation open (laser dot showing) for the
 * screenshot (dev/harness/dist/shots/present-*.png).
 */
import { makePart, addState, withPose, SetPageStates } from "../../src/model/states";
import { readPresentSettings } from "../../src/view/present-logic";
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface PresentCheckApi {
	view: unknown;
	setTool: (tool: string) => void;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string }) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface PresentView extends HarnessView {
	host: HarnessView["host"] & { settings: HarnessView["host"]["settings"] & { presentSteps: boolean; presentLaser: boolean } };
	presentation: { isOpen: boolean; position: { page: number; state: string | null }; writing: boolean } | null;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export async function checkPresent(api: PresentCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { frames } = api;
	const v = api.view as PresentView;
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const root = (): HTMLElement | null => document.querySelector<HTMLElement>(".nb-present");
	const counter = (): string => root()?.querySelector(".nb-present-counter")?.textContent ?? "";
	const settle = async () => {
		await frames(3);
		await sleep(80);
		await frames(2);
	};
	const key = async (k: string, extra: KeyboardEventInit = {}) => {
		window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
		await settle();
	};
	const pointer = (type: string, x: number, y: number, pointerType = "touch", id = 7, buttons = 1) =>
		root()?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType, isPrimary: true, clientX: x, clientY: y, buttons, pressure: 0.5 }));
	const rect = () => root()!.getBoundingClientRect();
	const tapAt = async (fx: number, fy: number, pointerType = "touch") => {
		const r = rect();
		const x = r.left + fx * r.width;
		const y = r.top + fy * r.height;
		pointer("pointerdown", x, y, pointerType);
		pointer("pointerup", x, y, pointerType, 7, 0);
		await settle();
	};

	// --- a drawing with states on page 1: a block that moves in two states ---
	v.host.settings.presentSteps = true;
	v.host.settings.presentLaser = true;
	const page = v.document.pages[0]!;
	await api.penStroke([[0.2, 0.2], [0.34, 0.2], [0.34, 0.28], [0.2, 0.28], [0.2, 0.2]]);
	await settle();
	const stroke = page.strokes[page.strokes.length - 1];
	add("a stroke to move is on the first page", !!stroke, String(page.strokes.length));
	if (stroke) {
		const part = makePart(undefined, [stroke])!;
		const s1 = addState(part.states, "One")!;
		const p1 = withPose(s1.states, s1.stateId, part.partId, { dx: 120 });
		const s2 = addState(p1, "Two", s1.stateId)!;
		const p2 = withPose(s2.states, s2.stateId, part.partId, { dx: 240 });
		v.applyCommand(new SetPageStates(page.id, undefined, { parts: p2.parts, list: p2.list }));
	}
	await settle();
	add("the first page has two states", (page.states?.list.length ?? 0) === 2);
	await v.flushNow();
	await settle();
	const before = JSON.stringify(v.document);

	// --- start: the action, full screen overlay on black, the page fitted ---
	// The PDF Select text mode is left when the presentation starts, and cannot be entered while it runs.
	const pdfTools = (v as unknown as { pdfTextTools: { enter(): void; active: boolean } | null }).pdfTextTools;
	pdfTools?.enter();
	v.runAction("present");
	await settle();
	await sleep(250);
	const r0 = root();
	add("Present opens the overlay", !!r0 && v.presentation?.isOpen === true);
	add("Presenting leaves the Select text mode", !!pdfTools && !pdfTools.active);
	v.runAction("pdf-select-text");
	add("the Select text command does nothing while presenting", !pdfTools?.active);
	const img = (): HTMLImageElement | null => root()?.querySelector<HTMLImageElement>(".nb-present-page") ?? null;
	for (let i = 0; i < 30 && !(img()?.getAttribute("src") ?? "").startsWith("data:"); i++) await sleep(50);
	add("the page is drawn as an image", (img()?.getAttribute("src") ?? "").startsWith("data:"));
	const ib = img()?.getBoundingClientRect();
	const rb = rect();
	add("the page is fitted inside the screen, centred, never cropped", !!ib && ib.left >= rb.left - 1 && ib.right <= rb.right + 1 && ib.top >= rb.top - 1 && ib.bottom <= rb.bottom + 1
		&& Math.abs((ib.left + ib.right) / 2 - (rb.left + rb.right) / 2) < 2, ib ? `${Math.round(ib.width)}x${Math.round(ib.height)} in ${Math.round(rb.width)}x${Math.round(rb.height)}` : "");
	add("the surround is black", getComputedStyle(root()!).backgroundColor === "rgb(0, 0, 0)", getComputedStyle(root()!).backgroundColor);
	add("the counter starts at page 1", counter().startsWith("1 / 5"), counter());
	add("the counter has the step of the drawing", counter().includes("1/3"), counter());

	// --- keys: the states first, then the pages ---
	await key("ArrowRight");
	add("Next shows state One before any page change", v.presentation?.position.page === 0 && v.presentation.position.state === page.states?.list[0]?.id && counter().includes("2/3"), counter());
	await key("PageDown");
	add("Next again shows state Two", v.presentation?.position.state === page.states?.list[1]?.id && counter().includes("3/3"), counter());
	await key("PageDown");
	add("then it turns the page", v.presentation?.position.page === 1 && v.presentation.position.state === null && counter().startsWith("2 / 5"), counter());
	await key("ArrowLeft");
	add("Previous comes back to the last state of the page before", v.presentation?.position.page === 0 && v.presentation.position.state === page.states?.list[1]?.id, JSON.stringify(v.presentation?.position));
	await key(" ", { shiftKey: true });
	add("Shift+Space is previous", v.presentation?.position.state === page.states?.list[0]?.id);
	await key("End");
	add("End goes to the last page", v.presentation?.position.page === 4 && counter().startsWith("5 / 5"), counter());
	await key("PageDown");
	add("Next on the last page stays there", v.presentation?.position.page === 4);
	await key("Home");
	add("Home goes to the first page", v.presentation?.position.page === 0 && v.presentation.position.state === null);
	await key("b");
	add("B blanks the screen", root()?.classList.contains("is-blank") === true);
	await key("ArrowRight");
	add("and any move brings it back", root()?.classList.contains("is-blank") === false);

	// --- taps and swipes ---
	await tapAt(0.8, 0.5);
	add("a tap on the right goes on", v.presentation?.position.page === 0 && v.presentation.position.state === page.states?.list[1]?.id, JSON.stringify(v.presentation?.position));
	await tapAt(0.1, 0.5);
	add("a tap on the left goes back", v.presentation?.position.state === page.states?.list[0]?.id);
	await tapAt(0.5, 0.01);
	add("a tap on the top strip only shows the controls", v.presentation?.position.state === page.states?.list[0]?.id && root()?.querySelector(".nb-present-bar")?.classList.contains("is-shown") === true);
	{
		const r = rect();
		pointer("pointerdown", r.left + r.width * 0.7, r.top + r.height * 0.5);
		pointer("pointermove", r.left + r.width * 0.5, r.top + r.height * 0.5);
		pointer("pointerup", r.left + r.width * 0.3, r.top + r.height * 0.5, "touch", 7, 0);
		await settle();
		add("a swipe to the left goes on", v.presentation?.position.state === page.states?.list[1]?.id, JSON.stringify(v.presentation?.position));
		pointer("pointerdown", r.left + r.width * 0.3, r.top + r.height * 0.5);
		pointer("pointerup", r.left + r.width * 0.7, r.top + r.height * 0.5, "touch", 7, 0);
		await settle();
		add("a swipe to the right goes back", v.presentation?.position.state === page.states?.list[0]?.id);
	}

	// --- the laser pointer ---
	{
		const r = rect();
		const canvas = root()!.querySelector<HTMLCanvasElement>(".nb-present-laser")!;
		const painted = (): boolean => {
			const ctx = canvas.getContext("2d");
			if (!ctx || canvas.width < 2) return false;
			const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
			for (let i = 3; i < d.length; i += 16) if ((d[i] ?? 0) > 20) return true;
			return false;
		};
		const pos = v.presentation!.position;
		pointer("pointerdown", r.left + r.width * 0.5, r.top + r.height * 0.5, "pen", 9);
		for (let i = 0; i < 8; i++) {
			pointer("pointermove", r.left + r.width * (0.5 + i * 0.03), r.top + r.height * (0.5 - i * 0.02), "pen", 9);
			await sleep(12);
		}
		await frames(2);
		add("the pen draws a red laser dot with a trail", painted());
		pointer("pointerup", r.left + r.width * 0.7, r.top + r.height * 0.4, "pen", 9, 0);
		await sleep(60);
		add("the pen never turns the page", JSON.stringify(v.presentation!.position) === JSON.stringify(pos));
		await sleep(2400);
		add("the trail fades out by itself", !painted());
		add("the laser wrote no ink", JSON.stringify(v.document) === before);
	}

	// --- the controls and the counter hide by themselves ---
	await key("ArrowRight");
	add("the counter is shown after a move", root()?.querySelector(".nb-present-counter")?.classList.contains("is-shown") === true);
	await sleep(3200);
	add("the counter and the controls hide by themselves", root()?.querySelector(".nb-present-counter")?.classList.contains("is-shown") === false && root()?.querySelector(".nb-present-bar")?.classList.contains("is-shown") === false);
	const buttons = Array.from(root()?.querySelectorAll<HTMLButtonElement>(".nb-present-btn") ?? []);
	add("three controls: laser, write, exit - each labelled", buttons.length === 3 && buttons.every((b) => !!b.getAttribute("aria-label")), buttons.map((b) => b.getAttribute("aria-label")).join(","));
	add("every control is a 44 px target", buttons.every((b) => b.getBoundingClientRect().width >= 43.5 || b.getBoundingClientRect().width === 0), buttons.map((b) => Math.round(b.getBoundingClientRect().width)).join(","));

	// --- write while presenting ---
	const inkBtn = buttons[1];
	inkBtn?.click();
	await settle();
	add("the write toggle hands the screen to the notebook", v.presentation?.writing === true && root()?.classList.contains("is-ink") === true && getComputedStyle(root()!).pointerEvents === "none");
	add("and the notebook is on the presented page", v.currentPage() === (v.presentation?.position.page ?? -1), `${v.currentPage()}`);
	await key("PageDown");
	add("keys still turn pages while writing", v.presentation?.position.page === 1 && v.currentPage() === 1, `${v.currentPage()}`);
	root()?.querySelectorAll<HTMLButtonElement>(".nb-present-btn")[1]?.click();
	await settle();
	add("switching it off gives the screen back", v.presentation?.writing === false && root()?.classList.contains("is-ink") === false);

	// --- exit, and the document is untouched ---
	await key("Escape");
	add("Escape ends the presentation", root() === null && v.presentation?.isOpen === false);
	add("the notebook is on the page the presentation ended on", v.currentPage() === 1, `${v.currentPage()}`);
	const after = JSON.stringify(v.document);
	let at = 0;
	while (at < before.length && before[at] === after[at]) at++;
	add("presenting changed nothing in the document", after === before, `${before.length} vs ${after.length} at ${at}: ${before.slice(at - 60, at + 60)} | ${after.slice(at - 60, at + 150)}`);

	// --- the settings ---
	v.host.settings.presentSteps = false;
	v.runAction("present");
	await settle();
	await key("Home");
	await key("ArrowRight");
	add("with stepping off, Next goes straight to the next page", v.presentation?.position.page === 1 && counter() === "2 / 5", counter());
	await key("Escape");
	add("the settings read back leniently", readPresentSettings({ presentSteps: 1 }).presentSteps === true);

	// --- the screenshot: presenting page 1 in its second state, the laser on it, the controls shown ---
	v.host.settings.presentSteps = true;
	v.scrollToPage(0);
	await settle();
	v.runAction("present");
	await settle();
	await sleep(250);
	await key("ArrowRight");
	await key("ArrowRight");
	{
		const r = rect();
		pointer("pointerdown", r.left + r.width * 0.3, r.top + r.height * 0.3, "pen", 11);
		for (let i = 0; i < 10; i++) {
			pointer("pointermove", r.left + r.width * (0.3 + i * 0.025), r.top + r.height * (0.3 + i * 0.012), "pen", 11);
			await sleep(10);
		}
		root()?.querySelector(".nb-present-bar")?.classList.add("is-shown");
		root()?.querySelector(".nb-present-counter")?.classList.add("is-shown");
		await frames(2);
	}

	return {
		ok: results.every((r) => r.ok) && api.errors.length === 0,
		results,
		errors: api.errors,
		notices: api.notices,
		env: { pages: v.document.pages.length },
	};
}
