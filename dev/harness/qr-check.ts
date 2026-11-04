/**
 * 0.18 qr (roadmap #190): the "Show QR code" dialog on the `doc=qr` scenario (npm run harness:check). Checked: the dialog shows one
 * SVG code (black on white, with its quiet zone) that fits the screen and is square; the link it carries is the plugin's own
 * `obsidian://notebook` link (vault, path, page and page id) and reads back through the protocol parser; both buttons are 40 px
 * targets; a link too long for a code shows a message instead of a broken picture. The dialog is left on screen for the screenshot.
 */
import { PageQrModal, pageQrUri } from "../../src/view/qr-modal";
import { parseProtocolParams } from "../../src/integration/links";
import { encodeQr } from "../../src/model/qr";
import { App } from "./obsidian-stub";
import type { CheckResult } from "./reading-check";

export interface QrCheckApi {
	errors: string[];
	notices: string[];
}

export async function checkQr(api: QrCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });
	const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
	const app = new App();
	const file = { path: "Notebooks/Maths/Calculus.notebook" } as never;
	const uri = pageQrUri("Study vault", file, 3, "p-abc123");
	const target = parseProtocolParams(Object.fromEntries(new URL(uri).searchParams.entries()));
	add("the link reads back through the protocol parser", target.ok && target.path === "Notebooks/Maths/Calculus.notebook" && target.page === 3 && target.pageId === "p-abc123", uri);
	add("the link starts with the plugin's notebook link and names the vault", uri.startsWith("obsidian://notebook?vault=Study%20vault&path="), uri);

	new PageQrModal(app as never, uri, 3).open();
	await sleep(60);
	const modal = document.querySelector<HTMLElement>(".nb-qr-modal");
	const svg = modal?.querySelector<SVGSVGElement>(".nb-qr-svg") ?? null;
	const box = svg?.getBoundingClientRect();
	add("the dialog shows one code", !!svg && modal?.querySelectorAll(".nb-qr-svg").length === 1);
	add("the code is square and big enough to scan (at least 200 px)", !!box && Math.abs(box.width - box.height) < 1.5 && box.width >= 200, box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "");
	add("the code fits the screen", !!box && box.left >= 0 && box.right <= window.innerWidth + 1);
	add("it is black on white", svg?.querySelector("rect")?.getAttribute("fill") === "#ffffff" && svg?.querySelector("path")?.getAttribute("fill") === "#000000");
	const matrix = encodeQr(uri);
	const size = (matrix?.size ?? 0) + 8;
	add("the viewBox holds the code and a four-module quiet zone", !!matrix && svg?.getAttribute("viewBox") === `0 0 ${size} ${size}`);
	const buttons = Array.from(modal?.querySelectorAll<HTMLButtonElement>(".nb-modal-foot .nb-modal-btn") ?? []);
	add("two buttons, both 40 px targets", buttons.length === 2 && buttons.every((b) => b.getBoundingClientRect().height >= 40), buttons.map((b) => b.textContent).join(","));
	add("the dialog fits the screen", !!modal && modal.getBoundingClientRect().left >= 0 && modal.getBoundingClientRect().right <= window.innerWidth + 1);
	if (modal && !modal.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(modal);

	// A link that cannot fit: a message, no picture.
	const long = new PageQrModal(app as never, `obsidian://notebook?path=${"a".repeat(400)}`, 1);
	long.open();
	await sleep(40);
	add("a link too long for a code shows a message and no picture", !!long.contentEl.querySelector(".nb-modal-error") && !long.contentEl.querySelector(".nb-qr-svg"));
	long.close();
	await sleep(20);
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}
