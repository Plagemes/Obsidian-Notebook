/**
 * 0.13 home2: Home's revised structure in the browser harness (doc=library&surface=home, variants lecture / create / last,
 * and the empty and hostile vaults through the existing scenarios). `checkHome2()` checks the layout of every new piece
 * (greeting, Continue row, low quick actions, three-column folder grid with the dashed tile last, grouped Recent notes with
 * thumbnails, the statistics widgets, the sidebar's Pinned section and pages) and then drives the new controls: the hero,
 * the Quick page card, the tooltips, the subject filter, the ⋯ menu of a page, pinning, the 7 / 14 day switch and the
 * "Import your first PDF" hint. It leaves the screen as it found it. `home2State()` sets up states for review screenshots.
 */
import type { LibraryHarness } from "./library-check";
import { t } from "../../src/i18n";

type Result = { name: string; ok: boolean; detail: string };
type MenuApi = { titles: string[]; run: (title: string) => void };

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const frames = async (n = 2) => {
	for (let i = 0; i < n; i++) await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
};

function visible(el: Element): el is HTMLElement {
	const h = el as HTMLElement;
	if (!h.offsetParent && getComputedStyle(h).position !== "fixed") return false;
	const r = h.getBoundingClientRect();
	return r.width > 0 && r.height > 0;
}

const app = () => document.querySelector<HTMLElement>(".nb-app")!;
const q = <T extends HTMLElement = HTMLElement>(sel: string) => app().querySelector<T>(sel);
const all = (sel: string) => Array.from(app().querySelectorAll<HTMLElement>(sel));
const shown = (sel: string) => all(sel).filter(visible);
const click = (el: Element | null | undefined) => (el as HTMLElement | null)?.click();

async function menuOf(button: Element | null): Promise<MenuApi | null> {
	const w = window as unknown as { harnessMenu?: MenuApi };
	w.harnessMenu = undefined;
	click(button);
	await frames(1);
	return w.harnessMenu ?? null;
}

/** The structure of Home on screen, for the variant the scenario opened. */
function checkLayout(variant: string): Result[] {
	const out: Result[] = [];
	const add = (name: string, ok: boolean, detail = "") => out.push({ name: `home2 ${window.innerWidth}px ${variant}: ${name}`, ok, detail });
	const root = app();
	const phone = root.classList.contains("is-phone");
	const medium = root.classList.contains("is-medium");

	// Header: the greeting replaces the fixed subtitle.
	const sub = q(".nb-page-subtitle")?.textContent ?? "";
	add("the header greets by name and counts today's pages", /Alex/.test(sub) && /3 pages written today/.test(sub), sub);

	// Continue row: hero 2/3, Quick page 1/3.
	const hero = q(".nb-home-continue .nb-continue");
	const quickPage = q(".nb-home-continue .nb-quickpage");
	add("the Continue row has the hero and the Quick page card", !!hero && !!quickPage);
	if (hero && quickPage) {
		const a = hero.getBoundingClientRect(), b = quickPage.getBoundingClientRect();
		if (!phone) add("the hero is about twice as wide as the Quick page card", a.width / b.width > 1.7 && a.width / b.width < 2.3 && Math.abs(a.top - b.top) < 2, `${Math.round(a.width)} / ${Math.round(b.width)}`);
		else add("on a phone the Quick page card sits under the hero", b.top >= a.bottom - 1, `${Math.round(a.bottom)} / ${Math.round(b.top)}`);
		add("the Quick page card says what it does", q(".nb-quickpage-title")?.textContent === t("home.quickPage") && q(".nb-quickpage-desc")?.textContent === t("home.quickPage.desc"), q(".nb-quickpage-title")?.textContent ?? "");
	}
	const eyebrow = q(".nb-continue-eyebrow")?.textContent ?? "";
	const title = q(".nb-continue-title")?.textContent ?? "";
	const go = q(".nb-continue-go")?.textContent ?? "";
	const thumb = q(".nb-continue-thumb");
	if (variant === "lecture") {
		add("the hero shows the lecture in progress with its room", eyebrow.includes("B2") && title === "Anatomia" && go === t("home.continue.openLecture"), `${eyebrow} | ${title} | ${go}`);
		add("the hero has a large page thumbnail", !!thumb?.classList.contains("nb-page-thumb") && thumb.getBoundingClientRect().height >= (phone ? 120 : 180), String(Math.round(thumb?.getBoundingClientRect().height ?? 0)));
	} else if (variant === "create") {
		add("with no notebook yet the hero offers to create one in the course's folder", title === "Chimica organica" && go === t("home.continue.startNotebook", { course: "Chimica organica" }) && !!thumb?.classList.contains("is-blank") && (q(".nb-continue-meta")?.textContent ?? "").includes("Matematica"), `${title} | ${go}`);
	} else {
		add("without a lecture the hero continues the last notebook", eyebrow === t("home.continue.last") && title === "Fisiologia cardiovascolare" && go === t("home.continue.action"), `${eyebrow} | ${title} | ${go}`);
	}

	// Quick actions: low, icon and title, the description is the tooltip.
	const quick = shown(".nb-home-quick .nb-quick.is-compact");
	add("four low quick actions", quick.length === 4, String(quick.length));
	add("quick actions are low (at most 80 px) and show no description", quick.every((x) => x.getBoundingClientRect().height <= 80 && !x.querySelector(".nb-quick-desc")), quick.map((x) => Math.round(x.getBoundingClientRect().height)).join());
	add("the description is the tooltip and the accessible description", quick.every((x) => !!x.title && x.getAttribute("aria-description") === x.title), quick.map((x) => x.title).join(" | "));
	if (hero) add("quick actions come after the Continue row and before the folders", q(".nb-home-quick")!.getBoundingClientRect().top >= hero.getBoundingClientRect().bottom - 1 && q(".nb-home-quick")!.getBoundingClientRect().bottom <= q(".nb-home-subjects")!.getBoundingClientRect().top + 1);

	// Subject folders: columns by width, the dashed tile is the last cell.
	const grid = q(".nb-home-subjects .nb-subject-grid");
	const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0;
	add(`the folder grid has ${phone ? 1 : medium ? 2 : 3} column(s)`, cols === (phone ? 1 : medium ? 2 : 3), String(cols));
	const cards = shown(".nb-home-subjects .nb-subject-card");
	add("subject cards are low (at most 100 px)", cards.length > 0 && cards.every((c) => c.getBoundingClientRect().height <= 100), cards.map((c) => Math.round(c.getBoundingClientRect().height)).join());
	add("a card says its notebooks and pages", (cards[0]?.querySelector(".nb-subject-meta")?.textContent ?? "").includes("·"), cards[0]?.querySelector(".nb-subject-meta")?.textContent ?? "");
	const last = grid?.lastElementChild as HTMLElement | null;
	add("the dashed New folder card is the last cell of the grid", !!last?.classList.contains("nb-create-tile") && (grid?.querySelectorAll(".nb-create-tile").length ?? 0) === 1, last?.className ?? "");
	if (grid && last) {
		// The last cell reaches the grid's right edge and sits on the last row: no gap at the end.
		const g = grid.getBoundingClientRect(), l = last.getBoundingClientRect();
		const lastRowTop = Math.max(...(Array.from(grid.children) as HTMLElement[]).map((c) => Math.round(c.getBoundingClientRect().top)));
		add("the dashed card closes the grid: no gap at the end of the last row", Math.abs(l.right - g.right) < 2 && Math.round(l.top) === lastRowTop, `right ${Math.round(l.right)} / ${Math.round(g.right)}`);
	}

	// Recent notes: grouped by notebook, page thumbnails, a ⋯ menu, a subject filter.
	const groups = shown(".nb-home-recent .nb-recent-group");
	add("recent notes are grouped by notebook", groups.length >= 2 && groups.length <= 4 && new Set(groups.map((g) => g.querySelector(".nb-row-title")?.textContent)).size === groups.length, String(groups.length));
	const rows = shown(".nb-home-recent .nb-recent-page");
	add("every page row has a thumbnail on the left and a ⋯ menu on the right", rows.length > 0 && rows.every((r) => !!r.querySelector(".nb-recent-thumb") && !!r.querySelector(".nb-kebab") && r.firstElementChild === r.querySelector(".nb-recent-thumb") && r.lastElementChild === r.querySelector(".nb-kebab")), String(rows.length));
	add("there is no file icon on a page row", rows.every((r) => !r.querySelector(".nb-row-icon")));
	const chips = shown(".nb-recent-filter .nb-chip");
	add("a chip filter by subject (All + the four subjects)", chips.length === 5 && chips[0]!.classList.contains("is-active"), chips.map((c) => c.textContent).join(" | "));

	// Statistics.
	const bars = shown(".nb-stat-chart .nb-bar-col");
	add("the pages chart has a bar per day (7), today last", bars.length === 7 && bars[6]!.classList.contains("is-today"), String(bars.length));
	add("the chart is named for assistive tech", (q(".nb-bars")?.getAttribute("aria-label") ?? "").includes("7"), q(".nb-bars")?.getAttribute("aria-label") ?? "");
	add("the 7 / 14 day switch shows 7", shown(".nb-segment").length === 2 && q(".nb-segment.is-active")?.textContent === t("home.stats.days", { n: "7" }), shown(".nb-segment").map((x) => x.textContent).join());
	add("the streak widget counts 5 days in a row", q('[data-key="stat:streak"] .nb-stat-value')?.textContent === "5", q('[data-key="stat:streak"] .nb-stat-value')?.textContent ?? "none");
	add("the writing time is shown as an estimate", (q('[data-key="stat:time"] .nb-stat-label')?.textContent ?? "") === t("home.stats.time") && /\d/.test(q('[data-key="stat:time"] .nb-stat-value')?.textContent ?? ""), q('[data-key="stat:time"] .nb-stat-value')?.textContent ?? "none");
	add("the most active subject has a bar split by subject colour", shown(".nb-split-seg").length >= 3 && new Set(all(".nb-split-seg").map((s) => s.style.getPropertyValue("--nb-c"))).size === all(".nb-split-seg").length, String(shown(".nb-split-seg").length));
	const hint = q('[data-key="stat:pdf"], [data-key="stat:pdf-hint"]');
	add("the PDF widget shows the count (the library has a PDF notebook, not changed this week) or nothing", !q('[data-key="stat:pdf-hint"]'), hint?.dataset.key ?? "none");
	add("the statistics sit next to Recent notes on a wide view and under it otherwise", (() => {
		const r = q(".nb-home-recent")?.getBoundingClientRect(), s = q(".nb-home-stats")?.getBoundingClientRect();
		if (!r || !s) return false;
		return root.classList.contains("is-wide") ? Math.abs(r.top - s.top) < 4 : s.top >= r.bottom - 1;
	})());

	// Sidebar: pages beside the notebook count; the Pinned section above the Vault.
	const labels = all(".nb-rail-section").map((x) => x.textContent);
	add("the sidebar has Pinned above Vault", labels.indexOf(t("nav.pinned")) >= 0 && labels.indexOf(t("nav.pinned")) < labels.indexOf(t("nav.vault")), labels.join());
	const withPages = all(".nb-rail-tree .nb-rail-pages");
	add("folders show their page count in the sidebar", withPages.length >= 4 && withPages.some((x) => /\d+ p/.test(x.textContent ?? "")), withPages.map((x) => x.textContent).join());
	const anat = q('.nb-rail-tree [data-key="folder:Notebooks/Anatomia"]');
	add("a folder's tooltip words notebooks and pages", /3 notebooks, 13 pages/.test(anat?.getAttribute("aria-label") ?? ""), anat?.getAttribute("aria-label") ?? "none");
	return out;
}

/** Drives the new controls of Home. */
async function checkControls(h: LibraryHarness, variant: string): Promise<Result[]> {
	const out: Result[] = [];
	const add = (name: string, ok: boolean, detail = "") => out.push({ name: `home2 ${window.innerWidth}px ${variant} interactions: ${name}`, ok, detail });
	const calls = (from: number) => h.calls.slice(from);

	// The hero opens the lecture / the last notebook, the Quick page card opens a new quick page.
	let n = h.calls.length;
	click(q(".nb-continue"));
	await frames(2);
	const heroCall = calls(n).join();
	add("tapping the hero does what its button says", variant === "last" ? heroCall.includes("Fisiologia cardiovascolare.notebook#2") : heroCall.includes("open-now-class"), heroCall);
	n = h.calls.length;
	click(q(".nb-continue-go"));
	add("its button does the same", variant === "last" ? calls(n).join().includes("#2") : calls(n).includes("open-now-class"), calls(n).join());
	n = h.calls.length;
	click(q(".nb-quickpage"));
	add("tapping Quick page opens a new page in Quick notes", calls(n).includes("quick-page"), calls(n).join());

	// The dashed tile creates a folder.
	n = h.calls.length;
	click(q(".nb-home-subjects .nb-create-tile"));
	add("the dashed New folder card opens the creation dialog", calls(n).includes("action:new-folder"), calls(n).join());

	// Recent notes: the subject filter.
	const titles = () => shown(".nb-home-recent .nb-recent-group .nb-pill").map((x) => x.textContent);
	const before = shown(".nb-home-recent .nb-recent-group").length;
	const chip = q('[data-key="recentchip:Notebooks/Fisiologia"]');
	click(chip);
	await frames(3);
	const filtered = shown(".nb-home-recent .nb-recent-group");
	const pillsOk = phone() ? true : titles().every((x) => x === "Fisiologia");
	add("choosing a subject chip keeps only that subject's notebooks", filtered.length >= 1 && filtered.length <= before && pillsOk && q('[data-key="recentchip:Notebooks/Fisiologia"]')?.classList.contains("is-active") === true, `${filtered.length} groups, ${titles().join()}`);
	click(q('[data-key="recentchip:all"]'));
	await frames(3);
	add("All brings the others back", shown(".nb-home-recent .nb-recent-group").length === before, String(shown(".nb-home-recent .nb-recent-group").length));

	// The ⋯ menu of a page: real actions.
	const kebab = q(".nb-home-recent .nb-recent-page .nb-kebab");
	const menu = await menuOf(kebab);
	const want = [t("home.recent.menu.open"), t("home.recent.menu.newTab"), t("home.recent.menu.reveal"), t("library.menu.pin")];
	add("a page's ⋯ menu offers open, new tab, reveal, pin and favourite", !!menu && want.every((x) => menu.titles.includes(x)) && (menu.titles.includes(t("library.favorite.add")) || menu.titles.includes(t("library.favorite.remove"))), menu?.titles.join(" | ") ?? "no menu");
	n = h.calls.length;
	menu?.run(t("home.recent.menu.open"));
	add("Open page opens that page", calls(n).some((c) => /^open:.+#\d+$/.test(c)), calls(n).join());

	// Pinning a notebook from Recent notes puts it in the sidebar's Pinned section; every pinned item opens on tap.
	const pinnedBefore = all(".nb-rail-pinned .nb-rail-item").length;
	const menu2 = await menuOf(q(".nb-home-recent .nb-recent-page .nb-kebab"));
	menu2?.run(t("library.menu.pin"));
	await wait(400);
	await frames(3);
	const pinned = all(".nb-rail-pinned .nb-rail-item");
	add("pinning from a recent note adds it to Pinned", pinned.length === pinnedBefore + 1, `${pinnedBefore} -> ${pinned.length}`);
	n = h.calls.length;
	click(pinned[pinned.length - 1]);
	add("a pinned notebook opens on tap", calls(n).some((c) => c.startsWith("open:")), calls(n).join());

	// Pinning a folder from its menu.
	const card = q('.nb-home-subjects .nb-subject-card[data-key="subject:Notebooks/Biomateriali"]');
	card?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
	await frames(1);
	const fm = (window as unknown as { harnessMenu?: MenuApi }).harnessMenu;
	add("a folder's menu offers to pin it", !!fm && fm.titles.includes(t("library.menu.pinFolder")), fm?.titles.join(" | ") ?? "no menu");
	fm?.run(t("library.menu.pinFolder"));
	await wait(200);
	await frames(3);
	const folderRow = q('.nb-rail-pinned [data-key="pinned:Notebooks/Biomateriali"]');
	add("the pinned folder is in the sidebar", !!folderRow, all(".nb-rail-pinned .nb-rail-item").map((x) => x.dataset.key).join());
	n = h.calls.length;
	click(folderRow);
	await frames(3);
	add("a pinned folder opens on tap", !!q(".nb-page-title") && q(".nb-page-title")!.textContent === "Biomateriali", q(".nb-page-title")?.textContent ?? "");
	click(q('.nb-rail [data-key="nav:home"]'));
	await frames(3);

	// Unpin both (the screen goes back to how it was).
	const unpin = async (anchor: Element | null, title: string) => {
		const m = await menuOf(anchor);
		m?.run(title);
		await wait(300);
		await frames(2);
	};
	card?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	(window as unknown as { harnessMenu?: MenuApi }).harnessMenu?.run(t("library.menu.unpinFolder"));
	await wait(200);
	for (let i = 0; i < 4 && all(".nb-rail-pinned .nb-rail-item").length > 0; i++) {
		const nbRow = all(".nb-rail-pinned .nb-rail-item")[0]!;
		nbRow.parentElement?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		await frames(1);
		(window as unknown as { harnessMenu?: MenuApi }).harnessMenu?.run(t("library.menu.unpin"));
		await wait(300);
		await frames(2);
	}
	void unpin;
	add("unpinning empties the Pinned section again (it shows how to pin)", all(".nb-rail-pinned .nb-rail-item").length === 0 && !!q(".nb-rail-hint"), String(all(".nb-rail-pinned .nb-rail-item").length));

	// The 7 / 14 day switch.
	click(q('[data-key="range:14"]'));
	await frames(3);
	add("the 14 day switch draws 14 bars", shown(".nb-stat-chart .nb-bar-col").length === 14 && q(".nb-segment.is-active")?.textContent === t("home.stats.days", { n: "14" }), String(shown(".nb-stat-chart .nb-bar-col").length));
	click(q('[data-key="range:7"]'));
	await frames(3);
	add("and back to 7", shown(".nb-stat-chart .nb-bar-col").length === 7);
	q(".nb-scroll")!.scrollTop = 0;
	return out;
}

const phone = () => app().classList.contains("is-phone");

/** Layout, then controls. */
export async function checkHome2(h: LibraryHarness, variant: string): Promise<Result[]> {
	// The scenario may have left the view in the library (the review states of the other checks): start from Home.
	click(q('.nb-rail [data-key="nav:home"]'));
	await frames(3);
	await wait(300);
	const layout = checkLayout(variant);
	const controls = await checkControls(h, variant);
	return [...layout, ...controls];
}

/** States for review screenshots: "pinned" (a notebook and a folder pinned), "range14", "reset". */
export async function home2State(h: LibraryHarness, state: string): Promise<boolean> {
	if (state === "pinned") {
		const card = q('.nb-home-subjects .nb-subject-card[data-key="subject:Notebooks/Anatomia"]');
		card?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		(window as unknown as { harnessMenu?: MenuApi }).harnessMenu?.run(t("library.menu.pinFolder"));
		const menu = await menuOf(q(".nb-home-recent .nb-recent-page .nb-kebab"));
		menu?.run(t("library.menu.pin"));
		await wait(500);
	} else if (state === "range14") {
		click(q('[data-key="range:14"]'));
	} else if (state === "reset") {
		click(q('[data-key="range:7"]'));
		for (let i = 0; i < 4 && all(".nb-rail-pinned .nb-rail-item").length > 0; i++) {
			const row = all(".nb-rail-pinned .nb-rail-item")[0]!;
			row.parentElement?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			await frames(1);
			const m = (window as unknown as { harnessMenu?: MenuApi }).harnessMenu;
			m?.run(m.titles.includes(t("library.menu.unpinFolder")) ? t("library.menu.unpinFolder") : t("library.menu.unpin"));
			await wait(300);
		}
	}
	void h;
	await frames(3);
	await wait(200);
	return true;
}
