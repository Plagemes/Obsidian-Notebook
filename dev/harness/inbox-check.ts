/**
 * 0.16 inbox (roadmap #177): files shared to the vault from other apps, on the `doc=inbox` scenario (npm run harness:check).
 * The real SharedInbox runs on the stub vault with the real Home view: new PDFs and images in the watched folder show up
 * as Home's "Shared files" card and the rail badge, files that were there before are not offered, other files and
 * subfolders are ignored, and every action works: "New notebook from it", "Add to notebook…" (PDF pages, image page, image
 * element), "Dismiss" (hidden, kept in the vault, remembered), "Move to trash" (asks first). The original is never deleted
 * without the confirmation. Home is left on screen; `inboxShot("list")` opens the full list for the screenshot.
 */
import { HomeView } from "../../src/library/home-view";
import type { LibraryHost } from "../../src/library/library-view";
import { SharedInbox } from "../../src/library/shared-inbox";
import { DISMISSED_KEY } from "../../src/library/shared-inbox-logic";
import { SharedInboxModal } from "../../src/library/shared-inbox-ui";
import { createDocument, createPage } from "../../src/model/document";
import { parse, serialize } from "../../src/model/serialize";
import { DEFAULT_SETTINGS, type NotebookSettings } from "../../src/settings";
import { t } from "../../src/i18n";
import { App, FuzzySuggestModal, WorkspaceLeaf, type TFile as StubFile } from "./obsidian-stub";
import type { WorkspaceLeaf as ObsidianLeaf } from "obsidian";
import type { CheckResult } from "./reading-check";

export interface InboxCheckApi {
	errors: string[];
	notices: string[];
}

const ROOT = "Notebooks";
const INBOX = "Inbox";
const DAY = 24 * 3600 * 1000;

interface Live {
	app: App;
	inbox: SharedInbox;
	settings: NotebookSettings;
	view: HomeView;
	calls: string[];
}
let live: Live | null = null;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const frames = async (n = 3) => {
	for (let i = 0; i < n; i++) await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
	await sleep(20);
};

async function pngBytes(w: number, h: number, color: string): Promise<ArrayBuffer> {
	const c = createEl("canvas");
	c.width = w;
	c.height = h;
	const g = c.getContext("2d")!;
	g.fillStyle = color;
	g.fillRect(0, 0, w, h);
	g.fillStyle = "#ffffff";
	g.fillRect(w / 4, h / 4, w / 2, h / 2);
	const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
	if (!blob) throw new Error("no PNG");
	return blob.arrayBuffer();
}

const pdfBytes = (n: number): ArrayBuffer => new TextEncoder().encode(`%PDF-1.4 harness ${n}\n%%EOF`).buffer;

function notebookText(pages = 1): string {
	const doc = createDocument(new Date(), { width: 595, height: 842 }, { kind: "blank", spacing: 28 });
	doc.pages = Array.from({ length: pages }, () => createPage({ width: 595, height: 842 }, { kind: "blank", spacing: 28 }));
	return serialize(doc);
}

function buttons(): HTMLButtonElement[] {
	return Array.from(document.querySelectorAll<HTMLButtonElement>(".modal button"));
}

function click(label: string): boolean {
	const b = buttons().find((x) => x.textContent?.trim() === label);
	b?.click();
	return !!b;
}

/** The picker of "Add to notebook…" is a search modal; the harness chooses the notebook whose name matches. */
function choosing(name: string): () => void {
	const proto = FuzzySuggestModal.prototype as unknown as { open: (this: FuzzySuggestModal<StubFile>) => void };
	const original = proto.open;
	proto.open = function (this: FuzzySuggestModal<StubFile>) {
		const item = this.getItems().find((f) => f.basename === name);
		if (item) this.onChooseItem(item);
		this.onClose();
	};
	return () => {
		proto.open = original;
	};
}

export async function checkInbox(api: InboxCheckApi): Promise<{ ok: boolean; results: CheckResult[]; errors: string[]; notices: string[]; env: Record<string, unknown> }> {
	const results: CheckResult[] = [];
	const add = (name: string, ok: unknown, detail = "") => results.push({ name, ok: !!ok, detail });

	const app = new App();
	const vault = app.vault;
	await vault.createFolder(ROOT);
	await vault.createFolder(`${ROOT}/_assets`);
	await vault.createFolder(INBOX);
	await vault.create(`${ROOT}/Maths.notebook`, notebookText());
	await vault.create(`${ROOT}/Physics.notebook`, notebookText());
	// A file that was already in the folder before the inbox first looked.
	const old = await vault.createBinary(`${INBOX}/Old scan.pdf`, pdfBytes(0));
	old.stat.ctime = Date.now() - 30 * DAY;

	const settings: NotebookSettings = { ...DEFAULT_SETTINGS, folder: ROOT, sharedInbox: true, sharedInboxFolder: INBOX };
	const calls: string[] = [];
	const inbox = new SharedInbox({
		app: app as never,
		settings: () => settings,
		pageSizes: async () => [{ width: 595, height: 842 }, { width: 842, height: 595 }],
		importPdfFrom: async (folder, file) => {
			calls.push(`import:${folder}:${file.path}`);
			await vault.create(`${folder}/${file.basename}.notebook`, notebookText());
			return true;
		},
		openNotebook: async (file) => void calls.push(`open:${file.path}`),
	});
	inbox.start({ registerEvent: (ref: unknown) => ref } as never);
	await sleep(50);
	add("files that were there before the inbox started are not offered", inbox.items().length === 0, String(inbox.items().length));

	// New files: PDF, two images, and things that must be ignored.
	await vault.createBinary(`${INBOX}/Lecture slides.pdf`, pdfBytes(1));
	await sleep(5);
	await vault.createBinary(`${INBOX}/Whiteboard.png`, await pngBytes(320, 200, "#2f80f7"));
	await sleep(5);
	await vault.createBinary(`${INBOX}/Extra.png`, await pngBytes(200, 320, "#f59e0b"));
	await vault.create(`${INBOX}/notes.txt`, "not a pdf");
	await vault.createBinary(`${INBOX}/sub/deep.pdf`, pdfBytes(2));
	await vault.createBinary(`${ROOT}/_assets/abcdef.pdf`, pdfBytes(3));
	await vault.createBinary(`${INBOX}/.hidden.png`, await pngBytes(8, 8, "#000000"));
	await sleep(30);
	const names = () => inbox.items().map((i) => i.name);
	add("new PDFs and images are offered, newest first", names().join(",") === "Extra.png,Whiteboard.png,Lecture slides.pdf", names().join(","));
	add("other files, subfolders, hidden files and the plugin's folders are ignored", !names().some((n) => /notes|deep|abcdef|hidden/.test(n)));

	// Home with the card and the rail badge.
	const host: LibraryHost = {
		root: () => ROOT,
		readNotebook: async (file) => {
			const r = parse(await vault.read(file as unknown as StubFile));
			return r.ok ? r.doc : null;
		},
		openNotebook: async (file) => void calls.push(`open:${file.path}`),
		createNotebook: () => undefined,
		createFolder: () => undefined,
		importPdf: () => undefined,
		updateMeta: async () => undefined,
		loadIndex: async () => null,
		saveIndex: async () => undefined,
		sharedInbox: () => inbox,
	};
	const root = document.getElementById("harness-app")!;
	root.empty();
	const leaf = new WorkspaceLeaf(app, root);
	const view = new HomeView(leaf as unknown as ObsidianLeaf, host);
	await view.onOpen();
	await sleep(400);
	const card = () => document.querySelector<HTMLElement>(".nb-home-shared");
	const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".nb-home-shared .nb-list-row"));
	add("Home shows the Shared files card with the count", !!card() && card()!.querySelector(".nb-dyn-count")?.textContent === "3" && rows().length === 3, `${rows().length} rows`);
	const rail = () => document.querySelector<HTMLElement>('.nb-rail [data-key="nav:shared"]');
	add("the rail has a Shared files item with the count", !!rail() && (rail()!.textContent ?? "").includes("3"), rail()?.textContent ?? "none");
	add("a row names the file, its kind and size", (rows()[0]?.textContent ?? "").includes("Extra.png") && (rows()[0]?.textContent ?? "").includes(t("si.kind.image")), rows()[0]?.textContent ?? "");

	// The row's menu offers the four actions.
	rows()[0]?.querySelector<HTMLElement>(".nb-kebab")?.click();
	const menu = (window as unknown as { harnessMenu?: { titles: string[]; run(title: string): void } }).harnessMenu;
	const wanted = [t("si.action.newNotebook"), t("si.action.addTo"), t("si.action.dismiss"), t("si.action.trash")];
	add("the menu offers the four actions", !!menu && wanted.every((w) => menu.titles.includes(w)), menu?.titles.join(" | ") ?? "no menu");

	// Dismiss: hidden here, still in the vault, remembered on this device and by a new session.
	menu?.run(t("si.action.dismiss"));
	await frames();
	add("dismiss hides the file and keeps it in the vault", names().join(",") === "Whiteboard.png,Lecture slides.pdf" && !!vault.getFileByPath(`${INBOX}/Extra.png`), names().join(","));
	add("the card and the badge follow", rows().length === 2 && (rail()?.textContent ?? "").includes("2"), `${rows().length}`);
	const stored = app.loadLocalStorage(DISMISSED_KEY);
	add("the dismissal is stored on this device, bounded", Array.isArray(stored) && stored.length === 1, JSON.stringify(stored));
	const again = new SharedInbox({ app: app as never, settings: () => settings, pageSizes: async () => [], importPdfFrom: async () => false, openNotebook: async () => undefined });
	await again.scan();
	add("a new session still hides it", again.items().map((i) => i.name).join(",") === "Whiteboard.png,Lecture slides.pdf");

	// Add a PDF to a notebook: its pages are appended as PDF background pages.
	let restore = choosing("Maths");
	const slides = inbox.items().find((i) => i.name === "Lecture slides.pdf")!;
	await inbox.addToNotebook(slides);
	restore();
	await frames();
	const maths = parse(await vault.read(vault.getFileByPath(`${ROOT}/Maths.notebook`)!));
	const mathsDoc = maths.ok ? maths.doc : null;
	add("the PDF's pages were appended to the notebook as PDF pages", !!mathsDoc && mathsDoc.pages.length === 3 && mathsDoc.pages[1]!.background?.kind === "pdf" && mathsDoc.pages[2]!.background?.kind === "pdf" && mathsDoc.pages[2]!.width === 842, mathsDoc ? `${mathsDoc.pages.length} pages` : "unreadable");
	add("the file is stored with the notebooks and recorded in them", !!mathsDoc && Object.values(mathsDoc.assets ?? {}).some((a) => a.kind === "pdf") && vault.getFiles().some((f) => f.path.startsWith(`${ROOT}/_assets/`) && f.extension === "pdf" && f.name !== "abcdef.pdf"));
	add("a notice says what was added", api.notices.some((n) => n === t("si.added.pdf", { file: "Lecture slides.pdf", name: "Maths", n: "2" })), api.notices[api.notices.length - 1] ?? "");
	add("the original is not deleted until the user confirms", !!vault.getFileByPath(`${INBOX}/Lecture slides.pdf`) && document.querySelector(".modal")?.textContent?.includes(t("si.original.title")) === true);
	add("the file left the list", !names().includes("Lecture slides.pdf"));
	click(t("si.action.trash"));
	await frames();
	add("Move to trash (confirmed) removes the original", !vault.getFileByPath(`${INBOX}/Lecture slides.pdf`));

	// Add an image as a new page, and another as an element.
	restore = choosing("Physics");
	const board = inbox.items().find((i) => i.name === "Whiteboard.png")!;
	const done = inbox.addToNotebook(board);
	await frames();
	const choices = Array.from(document.querySelectorAll<HTMLElement>(".nb-shared-placement .nb-modal-row"));
	add("an image asks where it goes: new page or on a page", choices.length === 2, choices.map((c) => c.textContent).join(" | "));
	choices[0]?.click();
	await done;
	restore();
	await frames();
	const physics = parse(await vault.read(vault.getFileByPath(`${ROOT}/Physics.notebook`)!));
	const physicsDoc = physics.ok ? physics.doc : null;
	const last = physicsDoc?.pages[physicsDoc.pages.length - 1];
	add("the image became a new last page with the image as its background", !!physicsDoc && physicsDoc.pages.length === 2 && last?.background?.kind === "image" && last.width > last.height, last ? `${last.width}x${last.height}` : "unreadable");
	click(t("library.modal.cancel"));
	await frames();
	add("Cancel keeps the original in place (and the file is out of the list)", !!vault.getFileByPath(`${INBOX}/Whiteboard.png`) && !names().includes("Whiteboard.png"));

	// New notebook from an image, and from a PDF.
	await vault.createBinary(`${INBOX}/Poster.png`, await pngBytes(640, 360, "#10b981"));
	await vault.createBinary(`${INBOX}/Handout.pdf`, pdfBytes(4));
	await sleep(20);
	const poster = inbox.items().find((i) => i.name === "Poster.png")!;
	await inbox.newNotebook(poster);
	await frames();
	const made = vault.getFileByPath(`${ROOT}/Poster.notebook`);
	const madeDoc = made ? parse(await vault.read(made)) : null;
	add("New notebook from an image: one page with the image, opened", !!madeDoc?.ok && madeDoc.doc.pages.length === 1 && madeDoc.doc.pages[0]!.background?.kind === "image" && calls.includes(`open:${ROOT}/Poster.notebook`), madeDoc && !madeDoc.ok ? madeDoc.message : "");
	click(t("library.modal.cancel"));
	await frames();
	const handout = inbox.items().find((i) => i.name === "Handout.pdf")!;
	await inbox.newNotebook(handout);
	await frames();
	add("New notebook from a PDF goes through the import path", calls.includes(`import:${ROOT}:${INBOX}/Handout.pdf`));
	click(t("library.modal.cancel"));
	await frames();
	add("the used files are out of the list and still in the vault", names().length === 0 && !!vault.getFileByPath(`${INBOX}/Poster.png`) && !!vault.getFileByPath(`${INBOX}/Handout.pdf`), names().join(","));

	// Move to trash asks first.
	await vault.createBinary(`${INBOX}/Junk.pdf`, pdfBytes(5));
	await sleep(20);
	const junk = inbox.items().find((i) => i.name === "Junk.pdf")!;
	inbox.moveToTrash(junk);
	await frames();
	add("Move to trash asks and names the file", (document.querySelector(".modal")?.textContent ?? "").includes("Junk.pdf") && !!vault.getFileByPath(`${INBOX}/Junk.pdf`));
	click(t("library.modal.cancel"));
	await frames();
	add("Cancel leaves it", !!vault.getFileByPath(`${INBOX}/Junk.pdf`) && names().includes("Junk.pdf"));
	inbox.moveToTrash(junk);
	await frames();
	click(t("si.action.trash"));
	await frames();
	add("Confirm moves it to the trash and off the list", !vault.getFileByPath(`${INBOX}/Junk.pdf`) && !names().includes("Junk.pdf"));

	// A file renamed out of the folder leaves; a file that is gone says so.
	await vault.createBinary(`${INBOX}/Gone.pdf`, pdfBytes(6));
	await sleep(20);
	const gone = inbox.items().find((i) => i.name === "Gone.pdf")!;
	await vault.rename(vault.getFileByPath(gone.path)!, `${ROOT}/Gone.pdf`);
	await sleep(20);
	add("a file moved out of the folder leaves the list", !names().includes("Gone.pdf"));
	await vault.createBinary(`${INBOX}/Vanished.png`, await pngBytes(20, 20, "#000000"));
	await sleep(20);
	const vanished = inbox.items().find((i) => i.name === "Vanished.png")!;
	(vault as unknown as { entries: Map<string, StubFile> }).entries.delete(vanished.path);
	const before = api.notices.length;
	await inbox.newNotebook(vanished);
	add("a file that is no longer there is reported, not used", api.notices.length === before + 1 && api.notices[before] === t("si.gone"), api.notices[before] ?? "");

	// The setting turns it off.
	settings.sharedInbox = false;
	add("with the setting off there is nothing to watch", inbox.items().length === 0 && !inbox.enabled());
	settings.sharedInbox = true;

	// Leave Home with the card for the screenshot: four waiting files, three shown.
	for (const [name, color] of [["Cell biology.pdf", ""], ["Timetable.png", "#8b5cf6"], ["Lab photo.png", "#ec4899"], ["Chapter 3.pdf", ""]] as const) {
		await vault.createBinary(`${INBOX}/${name}`, color ? await pngBytes(300, 220, color) : pdfBytes(name.length));
		await sleep(8);
	}
	await frames();
	await sleep(200);
	add("the card shows three rows and 'Show all' for the rest", rows().length === 3 && !!card()?.querySelector(".nb-link") && card()?.querySelector(".nb-dyn-count")?.textContent === "4", `${rows().length}`);
	const showAll = card()?.querySelector<HTMLElement>(".nb-link");
	showAll?.click();
	await frames();
	const listRows = document.querySelectorAll(".nb-shared-modal .nb-shared-list .nb-list-row").length;
	add("'Show all' opens the full list", listRows === 4, String(listRows));
	const closeX = document.querySelector<HTMLElement>(".nb-shared-modal .nb-modal-close");
	closeX?.click();
	await frames();
	add("the full list closes", !document.querySelector(".nb-shared-modal") || !document.querySelector(".nb-shared-modal")?.isConnected);

	live = { app, inbox, settings, view, calls };
	return { ok: results.every((r) => r.ok) && api.errors.length === 0, results, errors: api.errors, notices: api.notices, env: { dpr: window.devicePixelRatio } };
}

/** Screenshot states: "list" opens the full list over Home, "close" closes it. */
export async function inboxShot(state: "list" | "close"): Promise<boolean> {
	if (!live) return false;
	if (state === "list") {
		new SharedInboxModal(live.app as never, live.inbox).open();
		await frames();
		const modal = document.querySelector<HTMLElement>(".nb-shared-modal");
		if (modal && !modal.closest(".harness-modal-container")) document.body.createDiv({ cls: "harness-modal-container" }).appendChild(modal);
		await frames();
		return true;
	}
	document.querySelector<HTMLElement>(".nb-shared-modal .nb-modal-close")?.click();
	await frames();
	return true;
}
