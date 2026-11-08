/**
 * Smoke check of the long-press explanation (0.24, roadmap #429) on the real notebook view (doc=iconhelp, the blank "New"
 * notebook; HARNESS_DOC=iconhelp npm run harness:check). A finger held on a toolbar icon shows the bubble (name, one line, a
 * hint) and does not press the button; a swipe, a quick tap, a pen and a mouse show nothing; a tap elsewhere or the release
 * hides it; the setting turns it off. `iconhelpShot` leaves the bubble on the eraser (toolbar) showing for the screenshots.
 */
import { setLongPressHelpEnabled } from "../../src/ui/long-press-help";
import { HELP_LINGER_MS, HELP_PRESS_MS } from "../../src/ui/long-press-logic";
import type { CheckResult } from "./reading-check";

export interface IconhelpCheckApi {
	view: unknown;
	open: (doc?: string) => Promise<void>;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface IconhelpView {
	toolbar: { state: { tool: string } };
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const bubble = (): HTMLElement | null => document.querySelector<HTMLElement>(".nb-help-bubble");
const toolButton = (n: number): HTMLElement => document.querySelectorAll<HTMLElement>(".notebook-tool-button")[n]!;

function fire(el: Element, type: string, kind: string, x: number, y: number, id = 41): void {
	el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: kind, isPrimary: true, clientX: x, clientY: y }));
}
function centre(el: Element): [number, number] {
	const r = el.getBoundingClientRect();
	return [r.left + r.width / 2, r.top + r.height / 2];
}

export async function iconhelpShot(api: IconhelpCheckApi): Promise<void> {
	await api.open("iconhelp");
	setLongPressHelpEnabled(true);
	await api.frames(3);
	const eraser = toolButton(2);
	const [x, y] = centre(eraser);
	fire(eraser, "pointerdown", "touch", x, y);
	await sleep(HELP_PRESS_MS + 150);
}

export async function checkIconhelp(api: IconhelpCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	try {
		await api.open("iconhelp");
		const v = api.view as IconhelpView;
		setLongPressHelpEnabled(true);
		await api.frames(3);
		const eraser = toolButton(2);
		const [x, y] = centre(eraser);

		// A finger held on the eraser.
		fire(eraser, "pointerdown", "touch", x, y);
		await sleep(HELP_PRESS_MS - 150);
		add("nothing before the hold time", !bubble());
		await sleep(300);
		const b = bubble();
		add("the bubble shows after the hold", !!b);
		add("it names the button", b?.querySelector(".nb-help-name")?.textContent === eraser.getAttribute("aria-label"), b?.querySelector(".nb-help-name")?.textContent ?? "");
		add("it says what the tool does", (b?.querySelector(".nb-help-desc")?.textContent ?? "").length > 10, b?.querySelector(".nb-help-desc")?.textContent ?? "");
		add("it hints at the options", !!b?.querySelector(".nb-help-hint"));
		const br = b?.getBoundingClientRect();
		const anchor = eraser.getBoundingClientRect();
		add("it stays inside the screen", !!br && br.left >= 0 && br.right <= window.innerWidth && br.top >= 0 && br.bottom <= window.innerHeight, br ? `${Math.round(br.left)}..${Math.round(br.right)} of ${window.innerWidth}` : "none");
		add("it does not cover the icon", !!br && (br.top >= anchor.bottom - 1 || br.bottom <= anchor.top + 1));
		add("it never takes touches", !!b && getComputedStyle(b).pointerEvents === "none");

		// Release: the click that follows must not press the button, and the bubble goes after the linger.
		fire(eraser, "pointerup", "touch", x, y);
		eraser.click();
		await api.frames(2);
		add("the button was not pressed", v.toolbar.state.tool !== "eraser", v.toolbar.state.tool);
		await sleep(HELP_LINGER_MS + 200);
		add("the bubble hides after release", !bubble());

		// A tap right after still works.
		await sleep(900);
		eraser.click();
		await api.frames(2);
		add("a normal tap still presses it", v.toolbar.state.tool === "eraser", v.toolbar.state.tool);
		toolButton(0).click();
		await api.frames(2);

		// A quick tap and a swipe show nothing.
		fire(eraser, "pointerdown", "touch", x, y);
		await sleep(120);
		fire(eraser, "pointerup", "touch", x, y);
		await sleep(HELP_PRESS_MS);
		add("a quick tap shows nothing", !bubble());
		fire(eraser, "pointerdown", "touch", x, y);
		await sleep(100);
		fire(eraser, "pointermove", "touch", x + 30, y);
		await sleep(HELP_PRESS_MS + 100);
		add("a swipe shows nothing", !bubble());
		fire(eraser, "pointerup", "touch", x + 30, y);

		// Pen and mouse never.
		for (const kind of ["pen", "mouse"]) {
			fire(eraser, "pointerdown", kind, x, y, 42);
			await sleep(HELP_PRESS_MS + 150);
			add(`${kind} shows nothing`, !bubble());
			fire(eraser, "pointerup", kind, x, y, 42);
		}

		// A tap elsewhere hides it at once.
		fire(eraser, "pointerdown", "touch", x, y);
		await sleep(HELP_PRESS_MS + 150);
		add("shown again", !!bubble());
		fire(eraser, "pointerup", "touch", x, y);
		fire(document.body, "pointerdown", "touch", 5, window.innerHeight - 5, 43);
		add("a tap elsewhere hides it", !bubble());
		fire(document.body, "pointerup", "touch", 5, window.innerHeight - 5, 43);

		// Tool buttons that open options hint at it; the pages panel (a registry action) has its own description.
		const nav = document.querySelector<HTMLElement>("[data-action='toggle-pages-panel']");
		if (nav) {
			const [nx, ny] = centre(nav);
			fire(nav, "pointerdown", "touch", nx, ny, 44);
			await sleep(HELP_PRESS_MS + 150);
			add("a registry action explains itself", (bubble()?.querySelector(".nb-help-desc")?.textContent ?? "").length > 5);
			fire(nav, "pointerup", "touch", nx, ny, 44);
			fire(document.body, "pointerdown", "touch", 5, window.innerHeight - 5, 45);
			fire(document.body, "pointerup", "touch", 5, window.innerHeight - 5, 45);
		} else add("the pages button is there", false);

		// The setting.
		setLongPressHelpEnabled(false);
		fire(eraser, "pointerdown", "touch", x, y, 46);
		await sleep(HELP_PRESS_MS + 150);
		add("with the setting off there is no bubble", !bubble());
		fire(eraser, "pointerup", "touch", x, y, 46);
		setLongPressHelpEnabled(true);
	} catch (e) {
		add(`stopped: ${(e as Error).message}`, false, `after: ${results[results.length - 1]?.name ?? "start"}`);
	}
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
