/**
 * Smoke check of the floating reference window (0.20, roadmap #107) on the `doc=refwindow` notebook (the Outline notebook; npm run
 * harness:check): the real view with synthetic pointer events. Another page of the notebook opens in the window (page sheet action),
 * it sits inside the view, a pen inside it writes nothing and a pen outside it still does, fingers (the wheel here) zoom the
 * reference and "Fit" brings it back, the header moves it and the corner resizes it (never out of the view), the opacity slider fades
 * it, the minimise button leaves a chip that brings it back, the place is stored on the device, a Markdown note and a picture open in
 * it, and closing removes it. It leaves the window open on a page for the screenshot.
 */
import type { HarnessView } from "./harness-types";
import type { CheckResult } from "./reading-check";

export interface RefwindowCheckApi {
	view: unknown;
	app: unknown;
	penStroke: (points: Array<[number, number]>, opts?: { pointerType?: string; steps?: number }) => Promise<void>;
	setTool: (tool: string) => void;
	strokeCount: () => number;
	frames: (n: number) => Promise<void>;
	errors: string[];
	notices: string[];
}

interface RefView extends HarnessView {
	runAction(id: string, arg?: { page?: number; value?: string }): void;
	openReference(file: unknown, request?: { page: number | null; pageId: string | null }): Promise<void>;
	closeReference(): void;
	referenceOpen: boolean;
}

interface VaultLike {
	create(path: string, data: string): Promise<unknown>;
	createBinary(path: string, data: ArrayBuffer): Promise<unknown>;
	getFileByPath(path: string): unknown;
}

export async function checkRefwindow(api: RefwindowCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const { penStroke, setTool, strokeCount, frames } = api;
	const v = api.view as RefView;
	const app = api.app as { vault: VaultLike; loadLocalStorage(key: string): unknown };
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
	const q = <T extends HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
	const win = (): HTMLElement | null => q(".nb-refwin");
	const body = (): HTMLElement => q(".notebook-body")!;
	const box = (el: Element): DOMRect => el.getBoundingClientRect();
	const shown = (el: Element | null): boolean => !!el && getComputedStyle(el).display !== "none" && (el as HTMLElement).offsetWidth > 0;
	const within = (inner: DOMRect, outer: DOMRect): boolean =>
		inner.left >= outer.left - 0.5 && inner.top >= outer.top - 0.5 && inner.right <= outer.right + 0.5 && inner.bottom <= outer.bottom + 0.5;
	const settle = async (): Promise<void> => {
		await sleep(450);
		await frames(2);
	};
	const pointer = (el: Element, type: string, x: number, y: number, pointerType = "mouse"): void => {
		el.dispatchEvent(new PointerEvent(type, {
			bubbles: true, cancelable: true, composed: true, pointerId: 77, pointerType, isPrimary: true, clientX: x, clientY: y,
			button: 0, buttons: type === "pointerup" ? 0 : 1, pressure: 0.5,
		}));
	};
	const dragBy = async (el: Element, dx: number, dy: number, pointerType = "mouse"): Promise<void> => {
		const r = box(el);
		const x = r.left + r.width / 2, y = r.top + r.height / 2;
		pointer(el, "pointerdown", x, y, pointerType);
		for (let i = 1; i <= 5; i++) pointer(el, "pointermove", x + (dx * i) / 5, y + (dy * i) / 5, pointerType);
		pointer(el, "pointerup", x + dx, y + dy, pointerType);
		await frames(2);
	};
	const click = (sel: string): void => void q<HTMLButtonElement>(sel)?.click();
	const scaleOf = (): number => Number(q(".nb-refwin-layer")?.style.getPropertyValue("--nb-rw-ts") || "1");

	const total = v.document.pages.length;
	// --- open another page of this notebook from the registry (page sheet / palette action) ---
	add("no window before a reference is opened", !win());
	v.runAction("ref-page", { page: 1 });
	await settle();
	const w = win();
	add("the page action opens the window", !!w && shown(w));
	add("the window shows the page as a picture", !!w?.querySelector(".nb-refwin-layer img.nb-refwin-img"));
	add("the title names the notebook", (w?.querySelector(".nb-refwin-title")?.textContent ?? "").length > 0, w?.querySelector(".nb-refwin-title")?.textContent ?? "");
	add("the stepper says page 2", (w?.querySelector(".nb-refwin-steplabel")?.textContent ?? "").startsWith("2 /"), w?.querySelector(".nb-refwin-steplabel")?.textContent ?? "");
	add("the window is inside the view", !!w && within(box(w), box(body())), w ? JSON.stringify(box(w)) : "");
	add("Close is offered while a window is open", v.referenceOpen === true);

	// --- the pen: nothing inside, ink outside ---
	setTool("pen");
	const ink = strokeCount();
	const stage = q(".notebook-stage")!;
	const sr = box(stage);
	const wr = box(w!);
	const fx = (wr.left + wr.width / 2 - sr.left) / sr.width, fy = (wr.top + wr.height / 2 - sr.top) / sr.height;
	let reachedStage = 0;
	const seen = (): void => void reachedStage++;
	stage.addEventListener("pointerdown", seen);
	const before = q(".nb-refwin-layer")?.getAttribute("style") ?? "";
	await penStroke([[fx - 0.05, fy], [fx + 0.05, fy], [fx + 0.05, fy + 0.04]]);
	add("a pen inside the window writes nothing", strokeCount() === ink, `${ink} -> ${strokeCount()}`);
	add("a pen inside the window never reaches the page", reachedStage === 0, String(reachedStage));
	add("a pen inside the window does not move the reference", (q(".nb-refwin-layer")?.getAttribute("style") ?? "") === before);
	const x0 = Math.max(0.05, Math.min(0.2, (wr.left - sr.left) / sr.width - 0.2));
	await penStroke([[x0, 0.2], [x0 + 0.08, 0.22], [x0 + 0.1, 0.3]]);
	stage.removeEventListener("pointerdown", seen);
	add("a pen outside the window still writes", strokeCount() === ink + 1, `${ink} -> ${strokeCount()}`);
	add("the window covers only its own rectangle", box(w!).width < box(body()).width * 0.7 && box(w!).height < box(body()).height * 0.8);

	// --- pan and zoom with the fingers (the wheel here), fit ---
	const frame = q(".nb-refwin-frame")!;
	frame.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -600, clientX: box(frame).left + 60, clientY: box(frame).top + 60 }));
	await frames(2);
	add("the wheel zooms the reference", scaleOf() > 1.3, String(scaleOf()));
	await dragBy(frame, -40, -30, "touch");
	add("a finger drag keeps the reference over the frame", scaleOf() > 1.3);
	await sleep(500);
	add("the picture is still there after the zoom ended", !!q(".nb-refwin-layer img"));
	click(".nb-refwin-btn[aria-label='Fit to window']");
	await frames(2);
	add("Fit brings the zoom back", Math.abs(scaleOf() - 1) < 0.001, String(scaleOf()));

	// --- the page stepper ---
	if (total > 2) {
		click(".nb-refwin-btn[aria-label='Next page']");
		await settle();
		add("Next page shows page 3", (q(".nb-refwin-steplabel")?.textContent ?? "").startsWith("3 /"), q(".nb-refwin-steplabel")?.textContent ?? "");
	}

	// --- move and resize ---
	const head = q(".nb-refwin-head")!;
	const r0 = box(win()!);
	await dragBy(head, -120, -90);
	const r1 = box(win()!);
	add("dragging the header moves the window", r1.left < r0.left && r1.top < r0.top, `${r0.left},${r0.top} -> ${r1.left},${r1.top}`);
	await dragBy(head, -9000, -9000);
	add("a window dragged far away stays inside the view", within(box(win()!), box(body())));
	const grip = q(".nb-refwin-grip")!;
	const g0 = box(win()!);
	await dragBy(grip, 90, 70);
	const g1 = box(win()!);
	add("the corner resizes the window", g1.width > g0.width || g1.height > g0.height, `${g0.width}x${g0.height} -> ${g1.width}x${g1.height}`);
	await dragBy(grip, 9000, 9000);
	add("a window resized far stays inside the view", within(box(win()!), box(body())));
	await dragBy(grip, -9000, -9000);
	add("a window cannot be made smaller than its minimum", box(win()!).width >= 190 && box(win()!).height >= 150, `${box(win()!).width}x${box(win()!).height}`);
	await dragBy(grip, 200, 150);
	await sleep(450);
	const stored = app.loadLocalStorage("notebook-ref-window") as { landscape?: unknown; portrait?: unknown } | null;
	add("the place is stored on this device", !!stored && (!!stored.landscape || !!stored.portrait), JSON.stringify(stored));

	// --- opacity ---
	const slider = q<HTMLInputElement>(".nb-refwin-slider")!;
	slider.value = "55";
	slider.dispatchEvent(new Event("input", { bubbles: true }));
	slider.dispatchEvent(new Event("change", { bubbles: true }));
	await frames(2);
	add("the slider makes the window see-through", Math.abs(Number(getComputedStyle(win()!).opacity) - 0.55) < 0.02, getComputedStyle(win()!).opacity);

	// --- minimise to a chip and back ---
	click(".nb-refwin-btn[aria-label='Minimise']");
	await frames(2);
	const chip = q(".nb-refwin-chip")!;
	add("minimise leaves a chip and hides the window", shown(chip) && !shown(win()));
	add("the chip is inside the view", within(box(chip), box(body())));
	const c = box(chip);
	pointer(chip, "pointerdown", c.left + 20, c.top + 10);
	pointer(chip, "pointerup", c.left + 20, c.top + 10);
	await frames(2);
	add("a tap on the chip brings the window back", shown(win()) && !shown(chip));
	add("it comes back inside the view", within(box(win()!), box(body())));

	// --- a note and a picture ---
	await app.vault.create("Reference note.md", "# Chemistry notes\nMolar mass of water is 18 g/mol.\nA mole holds 6.022e23 particles.");
	await v.openReference(app.vault.getFileByPath("Reference note.md"));
	await settle();
	add("a Markdown note opens in the window", !!q(".nb-refwin-md") && (q(".nb-refwin-md")?.textContent ?? "").includes("Molar mass"));
	add("a note has no page stepper and no fit button", !shown(q(".nb-refwin-stepper")) && !shown(q(".nb-refwin-btn[aria-label='Fit to window']")));
	const canvas = createEl("canvas");
	canvas.width = 320;
	canvas.height = 200;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "#cfe8ff";
	ctx.fillRect(0, 0, 320, 200);
	ctx.fillStyle = "#1d4ed8";
	ctx.fillRect(40, 40, 240, 120);
	const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), "image/png"));
	await app.vault.createBinary("Reference picture.png", await blob.arrayBuffer());
	await v.openReference(app.vault.getFileByPath("Reference picture.png"));
	await settle();
	add("a picture opens in the window", !!q(".nb-refwin-layer img.nb-refwin-img"));

	// --- close ---
	v.closeReference();
	await frames(2);
	add("closing removes the window and the chip", !win() && !q(".nb-refwin-chip"));
	add("Close is not offered with no window", v.referenceOpen === false);

	// --- leave it open for the screenshot ---
	v.runAction("ref-page", { page: 1 });
	await settle();
	const again = q<HTMLInputElement>(".nb-refwin-slider");
	if (again) {
		again.value = "96";
		again.dispatchEvent(new Event("input", { bubbles: true }));
	}
	await frames(2);
	add("the window opens again inside the view", !!win() && within(box(win()!), box(body())));
	add("the ink written outside the window is still there", strokeCount() === ink + 1);

	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: [...api.errors], notices: [...api.notices], env: { dpr: window.devicePixelRatio, total } };
}
