/**
 * 0.22 syncprov (roadmap #126): the cloud sign-in dialog on the `doc=syncprov` scenario (npm run harness:check). The real
 * device-flow code runs against a scripted HTTP answer (no network): the dialog asks for a code, shows it big with its
 * address, Copy code, Open sign-in page and Cancel, and a countdown. Checked: the code and address are shown and fit the
 * screen, every button is a 40 px target, a refused sign-in shows the problem with Try again, and Cancel resolves the
 * dialog with null. The code state is left on screen for the screenshot.
 */
import { connectAccount } from "../../src/sync/auth/connect";
import type { Http, HttpRequest, HttpResponse } from "../../src/sync/auth/http";
import { abortError, type Clock } from "../../src/sync/auth/retry";
import { SignInError } from "../../src/sync/auth/device-flow";
import { SignInModal } from "../../src/sync/auth/sign-in-modal";
import type { Connected } from "../../src/sync/auth/connect";
import { App } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface SyncprovCheckApi {
	errors: string[];
	notices: string[];
}

function answer(status: number, body: unknown): HttpResponse {
	const text = JSON.stringify(body);
	return { status, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
}

/** Google's device endpoint answers with a code; the token endpoint is never reached (the clock waits until cancelled). */
const scripted: Http = {
	request: (req: HttpRequest) =>
		Promise.resolve(req.url.includes("/device/code")
			? answer(200, { device_code: "dev", user_code: "WDJB-MJHT", verification_url: "https://www.google.com/device", expires_in: 1800, interval: 5 })
			: answer(428, { error: "authorization_pending" })),
};

const waitingClock: Clock = {
	now: () => Date.now(),
	sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(abortError()), { once: true })),
};

export async function checkSyncprov(api: SyncprovCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const app = new App();
	const mount = (m: HTMLElement | null) => {
		if (m && !m.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(m);
	};

	// A refused sign-in: the problem and Try again.
	let refused: Connected | null | undefined;
	const bad = new SignInModal(app as never, "onedrive", () => Promise.reject(new SignInError("denied")), (r) => (refused = r));
	bad.open();
	await sleep(40);
	const badEl = document.querySelector<HTMLElement>(".nb-signin-modal");
	add("a refused sign-in shows the problem", !!badEl?.querySelector(".nb-modal-error"), badEl?.textContent ?? "");
	const badButtons = Array.from(badEl?.querySelectorAll<HTMLButtonElement>(".nb-modal-foot .nb-modal-btn") ?? []);
	add("with Cancel and Try again", badButtons.length === 2 && badButtons.every((b) => b.getBoundingClientRect().height >= 40), badButtons.map((b) => b.textContent).join(","));
	bad.close();
	await sleep(20);
	add("closing resolves the dialog with null", refused === null);

	// The waiting state, through the real device-flow code.
	let result: Connected | null | undefined;
	const modal = new SignInModal(app as never, "gdrive", (ui) => connectAccount(scripted, waitingClock, "gdrive", "id.apps.googleusercontent.com", ui, { clientSecret: "s" }), (r) => (result = r));
	modal.open();
	await sleep(80);
	const el = document.querySelector<HTMLElement>(".nb-signin-modal");
	mount(el);
	await sleep(20);
	const code = el?.querySelector<HTMLElement>(".nb-signin-code");
	const box = code?.getBoundingClientRect();
	add("the code is shown", code?.textContent === "WDJB-MJHT", code?.textContent ?? "");
	add("the code is big (at least 24 px)", !!code && parseFloat(getComputedStyle(code).fontSize) >= 24, code ? getComputedStyle(code).fontSize : "");
	add("the code fits the screen", !!box && box.left >= 0 && box.right <= window.innerWidth + 1);
	add("the address is shown", el?.querySelector(".nb-signin-url")?.textContent === "https://www.google.com/device");
	add("three steps are listed", el?.querySelectorAll(".nb-signin-steps li").length === 3);
	add("a countdown is shown", /\d+:\d{2}/.test(el?.querySelector(".nb-signin-status")?.textContent ?? ""), el?.querySelector(".nb-signin-status")?.textContent ?? "");
	const buttons = Array.from(el?.querySelectorAll<HTMLButtonElement>(".nb-modal-btn") ?? []);
	add("Copy code, Cancel and Open sign-in page, all 40 px targets", buttons.length === 3 && buttons.every((b) => b.getBoundingClientRect().height >= 40), buttons.map((b) => b.textContent).join(","));
	add("the dialog fits the screen", !!el && el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= window.innerWidth + 1);
	add("still waiting (no result yet)", result === undefined);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
