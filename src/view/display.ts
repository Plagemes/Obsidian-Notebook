// wave 0.9: view-only display options. Night mode (367) and "crop the white margins" of PDF pages (376). Both are view
// settings kept with the plugin settings, never in a notebook file; neither changes ink coordinates, stored colours,
// exports or thumbnails.
import { withWindows, type Layout, type Range } from "../ink/layout";
import type { Renderer } from "../ink/renderer";
import type { NotebookDocument, Page } from "../model/types";
import { pageWindow } from "../pdf/content-box";
import { ContentBoxes } from "./content-boxes";
import type { NotebookMedia } from "./media";
import type { DisplaySettings } from "./reading-settings";

export interface DisplayHost {
	settings(): DisplaySettings;
	save(): void;
	renderer(): Renderer | null;
	doc(): NotebookDocument | null;
	media(): NotebookMedia | null;
	currentPage(): number;
	/** The layout windows changed: build the layout again and fit the view. */
	reflow(): void;
	/** The toggles changed: update the toolbar, sheets and bars. */
	refreshUi(): void;
}

export class ViewDisplay {
	private readonly boxes: ContentBoxes;
	/** The windows the layout was last built with (rounded), to ignore results that change nothing visible. */
	private signature = "";
	private appliedCrop = false;

	constructor(private readonly host: DisplayHost) {
		this.boxes = new ContentBoxes({
			media: () => host.media(),
			changed: () => this.measured(),
		});
	}

	// --- night mode (367) ---

	get night(): boolean {
		return this.host.settings().nightMode;
	}

	toggleNight(): void {
		const s = this.host.settings();
		s.nightMode = !s.nightMode;
		this.host.save();
		this.applyNight();
		this.host.refreshUi();
	}

	/** The plugin settings changed (the settings tab, another open notebook): follow them. */
	settingsChanged(): void {
		this.applyNight();
		if (this.crop !== this.appliedCrop) this.cropChanged();
	}

	/** Pushes the setting to the renderer (also after the renderer is created or the settings change). */
	applyNight(): void {
		this.host.renderer()?.setNight(this.night);
	}

	// --- crop the white margins (376) ---

	get crop(): boolean {
		return this.host.settings().cropMargins;
	}

	toggleCrop(): void {
		const s = this.host.settings();
		s.cropMargins = !s.cropMargins;
		this.host.save();
		this.cropChanged();
		this.host.refreshUi();
	}

	/** The setting changed (the toggle, or the plugin settings): measure the pages if needed and lay the view out again. */
	cropChanged(): void {
		this.appliedCrop = this.crop;
		if (this.crop) this.start();
		else this.boxes.stop();
		this.signature = "";
		this.host.reflow();
	}

	/** The document was opened or its pages changed: measure the pages that are new while the crop is on. */
	docChanged(): void {
		if (this.crop) this.start();
	}

	private start(): void {
		const doc = this.host.doc();
		if (doc) this.boxes.ensure(doc.pages, this.host.currentPage());
	}

	/** The page's window, or null (no crop, not a PDF page, or no content found). */
	windowOf(page: Page): Range | null {
		return this.crop ? pageWindow(page, this.boxes.boxOf(page)) : null;
	}

	/** The layout with the windows of the PDF pages (the layout itself when the crop is off or nothing is measured yet). */
	shape(layout: Layout, pages: readonly Page[]): Layout {
		if (!this.crop) return layout;
		const shaped = withWindows(layout, (i) => {
			const page = pages[i];
			return page ? this.windowOf(page) : null;
		});
		this.signature = this.signatureOf(shaped);
		return shaped;
	}

	private signatureOf(layout: Layout): string {
		const step = Math.max(1, layout.width * 0.015);
		const r = (n: number) => Math.round(n / step);
		return layout.boxes.map((b) => (b.window ? `${r(b.window.x)}:${r(b.window.width)}` : "-")).join(",");
	}

	/** Pages are measured one at a time: lay out again only when a window moved by more than about a percent. */
	private measured(): void {
		const doc = this.host.doc();
		if (!doc || !this.crop) return;
		const widest = Math.max(1, ...doc.pages.map((p) => p.width));
		const probe: Layout = { boxes: doc.pages.map((p) => ({ x: 0, y: 0, width: p.width, height: p.height })), width: widest, height: 0 };
		const shaped = withWindows(probe, (i) => {
			const page = doc.pages[i];
			return page ? this.windowOf(page) : null;
		});
		if (this.signatureOf(shaped) !== this.signature) this.host.reflow();
	}

	destroy(): void {
		this.boxes.clear();
	}
}
