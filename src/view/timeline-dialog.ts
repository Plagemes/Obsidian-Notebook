import { Modal, type App } from "obsidian";
import { t, type MessageKey } from "../i18n";
import { previewLayout, TIMELINE_SIZES, timelineWidth, type TimelineChoice, type TimelineSize } from "../ink/timeline";
import { editNeedsFixing, MAX_EVENTS, MAX_LABEL, parseEventLines, type TimelineLabels, type TimelineLayout } from "../math/timeline-layout";
import { modalShell, shellButton, shellField, shellNote, type ModalShell } from "../ui/components/modal-shell";
import { SUBJECT_COLORS } from "../ui/palette";

/**
 * The "Timeline" dialog (0.30, roadmap #148), for a new timeline and for "Edit timeline": a title, the events as lines of text (a date, a
 * colon, the label), the colour of the dots and poles and the size. It only asks; the timeline is made by view/timeline-tools.ts. Built on
 * the modal shell. The picture is the very layout the timeline will have (`previewLayout`), drawn small, and the lines under it say what was
 * read (and which lines were left out and why). The last colour and size are remembered for the session.
 */

const SIZE_LABEL: Record<TimelineSize, MessageKey> = { compact: "timeline.size.compact", standard: "timeline.size.standard", wide: "timeline.size.wide" };
/** Lines of the problems that are listed one by one; the rest are counted. */
const MAX_LISTED = 3;

export interface TimelineDialogOptions {
	mode: "insert" | "edit";
	/** The page the timeline goes on (its width and height decide the sizes and whether the timeline fits). */
	page: { width: number; height: number; infinite?: boolean };
	title: string;
	text: string;
	colour: number;
	/** The block width of the timeline being edited: the size stays as it is unless the person picks another. */
	keepWidth?: number;
	size: TimelineSize;
	labels: TimelineLabels;
}

let last: { colour: number; size: TimelineSize } = { colour: 1, size: "standard" };

class TimelineDialog extends Modal {
	private shell!: ModalShell;
	private heading: string;
	private typed: string;
	private colour: number;
	private size: TimelineSize;
	private sizeTouched = false;
	private preview!: HTMLElement;
	private notes!: HTMLElement;
	private primary!: HTMLButtonElement;
	private answered = false;

	constructor(app: App, private readonly o: TimelineDialogOptions, private readonly finish: (c: TimelineChoice | null) => void) {
		super(app);
		this.heading = o.title;
		this.typed = o.text;
		this.colour = o.colour;
		this.size = o.size;
	}

	onOpen(): void {
		const edit = this.o.mode === "edit";
		this.shell = modalShell(this, { title: t(edit ? "timeline.titleEdit" : "timeline.title"), subtitle: t("timeline.subtitle"), icon: "move-horizontal", size: "narrow", cls: "nb-timeline-dialog", seed: "timeline" });
		const body = this.shell.body;
		const titleField = shellField(body, t("timeline.titleField"), "nb-timeline-title");
		const title = titleField.createEl("input", { cls: "nb-modal-input", attr: { id: "nb-timeline-title", type: "text", maxlength: "80", placeholder: t("timeline.titlePlaceholder") } });
		title.value = this.heading;
		title.addEventListener("input", () => {
			this.heading = title.value;
			this.draw();
		});
		const eventsField = shellField(body, t("timeline.events"), "nb-timeline-events");
		const area = eventsField.createEl("textarea", {
			cls: "nb-modal-input nb-timeline-events",
			attr: { id: "nb-timeline-events", rows: "7", placeholder: t("timeline.eventsPlaceholder"), spellcheck: "false", autocapitalize: "off", autocomplete: "off" },
		});
		area.value = this.typed;
		area.addEventListener("input", () => {
			this.typed = area.value;
			this.draw();
		});
		shellNote(eventsField, t("timeline.eventsHint"));
		this.colours(body);
		this.sizes(body);
		this.preview = body.createDiv({ cls: "nb-timeline-preview", attr: { role: "img", "aria-label": t("timeline.preview") } });
		this.notes = body.createDiv({ cls: "nb-timeline-notes" });
		shellButton(this.shell.foot, "secondary", t("transfer.cancel"), () => this.close());
		this.primary = shellButton(this.shell.foot, "primary", t(edit ? "timeline.updateButton" : "timeline.insertButton"), () => this.submit(), { icon: "move-horizontal" });
		this.draw();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.finish(null);
	}

	private choice(): TimelineChoice {
		const read = parseEventLines(this.typed);
		const keep = this.o.mode === "edit" && !this.sizeTouched;
		return { title: this.heading.trim(), colour: this.colour, size: keep ? "keep" : this.size, events: read.events };
	}

	private submit(): void {
		const choice = this.choice();
		if (choice.events.length === 0 || !this.fits(choice) || this.mustFix()) return;
		this.answered = true;
		if (this.o.mode === "insert") last = { colour: this.colour, size: this.size };
		this.close();
		this.finish(choice);
	}

	/** Review 0.30 (I4): an edit with a line that would be left out (and so its label box removed) waits until the person fixes or deletes it. */
	private mustFix(): boolean {
		return this.o.mode === "edit" && editNeedsFixing(parseEventLines(this.typed));
	}

	private layout(choice: TimelineChoice): TimelineLayout {
		return previewLayout(choice, this.o.page.width, this.o.labels, this.o.keepWidth);
	}

	/** Whether the timeline is not taller than the page (a page that goes on for ever always has room). */
	private fits(choice: TimelineChoice): boolean {
		if (choice.size !== "keep" && timelineWidth(choice.size, this.o.page.width) === null) return false;
		return this.o.page.infinite === true || this.layout(choice).height <= this.o.page.height - 16;
	}

	private sizes(parent: HTMLElement): void {
		const field = shellField(parent, t("timeline.size"));
		const seg = field.createDiv({ cls: "nb-segmented nb-timeline-seg", attr: { role: "group", "aria-label": t("timeline.size") } });
		const buttons: Array<[TimelineSize, HTMLButtonElement]> = [];
		const paint = (): void => {
			for (const [v, b] of buttons) {
				b.toggleClass("is-active", v === this.size);
				b.setAttribute("aria-pressed", String(v === this.size));
			}
		};
		for (const v of TIMELINE_SIZES) {
			const b = seg.createEl("button", { cls: "nb-segment", text: t(SIZE_LABEL[v]), attr: { type: "button" } });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				this.size = v;
				this.sizeTouched = true;
				paint();
				this.draw();
			});
			buttons.push([v, b]);
		}
		paint();
	}

	private colours(parent: HTMLElement): void {
		const field = shellField(parent, t("timeline.colours"));
		const row = field.createDiv({ cls: "nb-timeline-colours", attr: { role: "group", "aria-label": t("timeline.colours") } });
		const buttons: HTMLButtonElement[] = [];
		const paint = (): void => {
			buttons.forEach((b, i) => {
				b.toggleClass("is-active", i === this.colour);
				b.setAttribute("aria-pressed", String(i === this.colour));
			});
		};
		SUBJECT_COLORS.forEach((c, i) => {
			const b = row.createEl("button", { cls: "nb-timeline-swatch", attr: { type: "button", "aria-label": `${t("timeline.colours")} ${c.name}`, title: c.name } });
			b.setCssProps({ "--nb-timeline-swatch": c.base });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				this.colour = i;
				paint();
				this.draw();
			});
			buttons.push(b);
		});
		paint();
	}

	/** The picture and the lines under it (decoration and information: neither is a control). */
	private draw(): void {
		const read = parseEventLines(this.typed);
		const choice = this.choice();
		this.preview.empty();
		this.notes.empty();
		let ok = read.events.length > 0;
		if (ok) {
			const layout = this.layout(choice);
			paintTimeline(this.preview, layout);
			shellNote(this.notes, t("timeline.read", { n: String(read.events.length) }));
			if (layout.compressed > 0) shellNote(this.notes, t("timeline.read.gap"));
			if (!this.fits(choice)) {
				shellNote(this.notes, t("timeline.noRoom"), "error");
				ok = false;
			}
		} else shellNote(this.notes, t("timeline.read.none"), "error");
		for (const p of read.problems.slice(0, MAX_LISTED)) {
			const text = Array.from(p.text).slice(0, 30).join("");
			shellNote(this.notes, p.reason === "long" ? t("timeline.read.long", { line: String(p.line), max: String(MAX_LABEL) }) : t("timeline.read.bad", { line: String(p.line), text }));
		}
		if (read.problems.length > MAX_LISTED) shellNote(this.notes, t("timeline.read.more", { n: String(read.problems.length - MAX_LISTED) }));
		if (read.dropped > 0) shellNote(this.notes, t("timeline.read.dropped", { max: String(MAX_EVENTS), n: String(read.dropped) }));
		if (this.mustFix()) {
			shellNote(this.notes, t("timeline.read.keep"), "error");
			ok = false;
		}
		this.primary.disabled = !ok;
	}
}

/** A layout as a small SVG in `parent` (a picture of the timeline to come, not of the page: the page's own paper stays behind it). */
export function paintTimeline(parent: HTMLElement, layout: TimelineLayout): void {
	const svg = parent.createSvg("svg", { cls: "nb-timeline-preview-svg", attr: { viewBox: `0 0 ${layout.width} ${layout.height}`, "aria-hidden": "true" } });
	const num = (v: number): string => String(Math.round(v * 100) / 100);
	for (const s of layout.shapes) {
		const common: Record<string, string> = { fill: s.fill ?? "none", stroke: s.color, "stroke-width": num(s.width), "stroke-linejoin": "round", "stroke-linecap": "round" };
		if (s.dash === "dashed") common["stroke-dasharray"] = "5 4";
		if (s.type === "circle") svg.createSvg("circle", { attr: { cx: num(s.cx), cy: num(s.cy), r: num(s.r), ...common } });
		else {
			const points = s.vertices.map((v) => `${num(v[0])},${num(v[1])}`).join(" ");
			svg.createSvg(s.closed ? "polygon" : "polyline", { attr: { points, ...common } });
		}
	}
	for (const tx of layout.texts) {
		const el = svg.createSvg("text", { attr: { x: num(tx.x), y: num(tx.y + tx.size * 0.95), fill: tx.color, "font-size": num(tx.size), "font-family": "sans-serif" } });
		tx.lines.forEach((line, i) => {
			const span = el.createSvg("tspan", { attr: { x: num(tx.x), dy: i === 0 ? "0" : num(tx.size * 1.25) } });
			span.textContent = line;
		});
	}
}

/** Asks for a timeline; null when the dialog is closed without inserting. */
export function askTimeline(app: App, o: Omit<TimelineDialogOptions, "colour" | "size"> & Partial<Pick<TimelineDialogOptions, "colour" | "size">>): Promise<TimelineChoice | null> {
	const full: TimelineDialogOptions = { ...o, colour: o.colour ?? last.colour, size: o.size ?? last.size };
	return new Promise((resolve) => new TimelineDialog(app, full, resolve).open());
}
