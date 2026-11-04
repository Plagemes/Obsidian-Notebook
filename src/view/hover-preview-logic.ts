/**
 * 0.17 hover: pure logic of the page preview popover (O5): which `hover-link` links are ours, which page they name, and
 * whether the Page preview core plugin's settings allow showing it. No Obsidian imports: testable in Node.
 */
import { pageTargetFromSubpath, resolvePageTarget, type PageTarget } from "../integration/page-links";

/** Id of the hover source this plugin registers with Page preview. */
export const HOVER_SOURCE_ID = "notebook";

/** A link text split into its file part and its subpath (`Physics.notebook#p3&id=x` -> `Physics.notebook`, `#p3&id=x`). */
export function splitLinktext(linktext: string): { path: string; subpath: string } {
	const text = linktext.trim();
	const hash = text.indexOf("#");
	return hash < 0 ? { path: text, subpath: "" } : { path: text.slice(0, hash).trim(), subpath: text.slice(hash) };
}

/** Whether a link text can point at a notebook file (by extension), so that Markdown links are left alone without resolving them. */
export function mayBeNotebookLink(linktext: string, extensions: readonly string[]): boolean {
	const { path } = splitLinktext(linktext);
	const lower = path.toLowerCase();
	return extensions.some((ext) => lower.endsWith(`.${ext.toLowerCase()}`));
}

/** The page a link subpath names; a link without a page (or naming a heading) shows the first page. */
export function hoverTarget(subpath: string): PageTarget {
	return pageTargetFromSubpath(subpath) ?? { page: 1, pageId: null };
}

export type HoverPage = { index: number } | { missing: "deleted" };

/** The 0-based page a hover shows, or `deleted` when the link names a page id the notebook no longer has. */
export function hoverPage(pages: ReadonlyArray<{ id: string }>, target: PageTarget): HoverPage {
	if (pages.length === 0) return { missing: "deleted" };
	return resolvePageTarget(pages, target);
}

/** What the Page preview core plugin says: whether it is on, and per hover source whether Ctrl/Cmd must be held. */
export interface PagePreviewConfig {
	enabled: boolean;
	overrides: Record<string, boolean>;
}

/** Reads the (not typed) state of the core plugin leniently; unknown shapes mean "enabled, defaults". */
export function readPagePreviewConfig(internalPlugins: unknown): PagePreviewConfig {
	const out: PagePreviewConfig = { enabled: true, overrides: {} };
	if (typeof internalPlugins !== "object" || internalPlugins === null) return out;
	const plugin = (internalPlugins as { plugins?: Record<string, unknown> }).plugins?.["page-preview"];
	if (typeof plugin !== "object" || plugin === null) return out;
	const p = plugin as { enabled?: unknown; instance?: { overrides?: unknown } };
	if (p.enabled === false) out.enabled = false;
	const overrides = p.instance?.overrides;
	if (typeof overrides === "object" && overrides !== null) {
		for (const [key, value] of Object.entries(overrides)) if (typeof value === "boolean") out.overrides[key] = value;
	}
	return out;
}

/**
 * Whether the popover is shown: Page preview must be on, and when its setting for the event's source asks for Ctrl/Cmd
 * the key must be held. A source it has no setting for needs the key (Obsidian's default for the editor and reading view).
 */
export function shouldShowPreview(config: PagePreviewConfig, source: string, modHeld: boolean): boolean {
	if (!config.enabled) return false;
	const needsMod = config.overrides[source] ?? true;
	return !needsMod || modHeld;
}

/** The hover-link event of Obsidian's workspace (not part of the public typings). */
export interface HoverLinkEvent {
	event: MouseEvent;
	source: string;
	hoverParent: unknown;
	targetEl: HTMLElement | null;
	linktext: string;
	sourcePath?: string;
}

/** The event when it has what the preview needs, else null. */
export function asHoverLinkEvent(e: unknown): HoverLinkEvent | null {
	if (typeof e !== "object" || e === null) return null;
	const v = e as Partial<HoverLinkEvent>;
	if (typeof v.linktext !== "string" || typeof v.source !== "string" || !v.event || !v.targetEl) return null;
	return v as HoverLinkEvent;
}
