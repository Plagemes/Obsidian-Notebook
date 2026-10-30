/**
 * The creation dialog's rules (view/create-dialog.ts), kept pure so they are tested in Node: names, page sizes, folder
 * lists and what a new notebook's document holds. No 'obsidian' import.
 */
import { createDocument } from "../model/document";
import {
	COVER_ART_STYLES, META_DESCRIPTION_MAX, MM, PAGE_SIZES, PAPER_SPACING, type CoverArt, type CoverArtStyle, type NotebookDocument, type PageSizeName,
	type PaperKind,
} from "../model/types";
import { isReservedPath } from "../library/folders";

/** Characters Obsidian does not allow in file and folder names, plus those that break links (as storage/notebooks.ts). */
export const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|#^[\]]/;
/** Longest name accepted, in characters (file systems allow 255 bytes; this leaves room for the extension and UTF-8). */
export const MAX_NAME = 120;

export type NameProblem = "empty" | "chars" | "dot" | "long" | "exists";

/** Why `name` cannot be used for a new notebook or folder (null when it can). `exists`: whether that name is taken. */
export function nameProblem(name: string, exists: (clean: string) => boolean): NameProblem | null {
	const clean = name.trim();
	if (clean === "") return "empty";
	if (FORBIDDEN_NAME_CHARS.test(clean)) return "chars";
	if (clean.startsWith(".")) return "dot";
	if (clean.length > MAX_NAME) return "long";
	if (exists(clean)) return "exists";
	return null;
}

/** `parent/name` with "" or "/" as the vault root. */
export function joinPath(parent: string, name: string): string {
	const p = parent.replace(/^\/+|\/+$/g, "");
	return p ? `${p}/${name}` : name;
}

/** The page size presets in the order the dialog shows them. */
export const SIZE_CHOICES: readonly PageSizeName[] = ["a4", "a5", "b5", "letter"];
export type SizeChoice = PageSizeName | "custom";

/** Bounds of a custom page side, in mm. */
export const CUSTOM_MIN_MM = 50;
export const CUSTOM_MAX_MM = 1000;

/** A custom side in mm, or null when it is not a number within the bounds. */
export function customSide(text: string): number | null {
	const v = Number(text.replace(",", ".").trim());
	if (!Number.isFinite(v) || v < CUSTOM_MIN_MM || v > CUSTOM_MAX_MM) return null;
	return Math.round(v * 10) / 10;
}

/** Page size in pt: a preset (portrait, swapped for landscape) or a custom width × height in mm (also swapped so that landscape is wider). */
export function pageSize(choice: SizeChoice, landscape: boolean, customMm: { width: number; height: number }): { width: number; height: number } {
	const base = choice === "custom"
		? { width: Math.round(customMm.width * MM * 100) / 100, height: Math.round(customMm.height * MM * 100) / 100 }
		: PAGE_SIZES[choice];
	const short = Math.min(base.width, base.height);
	const long = Math.max(base.width, base.height);
	return landscape ? { width: long, height: short } : { width: short, height: long };
}

/** Folders a new notebook or folder can go in: the notebooks folder and every folder under it but the reserved ones, sorted. */
export function folderChoices(root: string, allFolders: readonly string[]): string[] {
	const r = root.replace(/^\/+|\/+$/g, "");
	const out = new Set<string>([r]);
	for (const p of allFolders) {
		if (p === "" || p === "/") continue;
		if (r !== "" && p !== r && !p.startsWith(`${r}/`)) continue;
		if (isReservedPath(p, r)) continue;
		out.add(p);
	}
	return [...out].sort((a, b) => (a === r ? -1 : b === r ? 1 : a.localeCompare(b)));
}

/** The folder the dialog starts in: the one asked for, else the last used, else the notebooks folder (each only if it is a choice). */
export function startFolder(choices: readonly string[], wanted: string | undefined, last: string | null): string {
	const norm = (p: string | null | undefined) => (p ?? "").replace(/^\/+|\/+$/g, "");
	if (wanted !== undefined && choices.includes(norm(wanted))) return norm(wanted);
	if (last !== null && choices.includes(norm(last))) return norm(last);
	return choices[0] ?? "";
}

/** Depth of `path` below `root` (0 for the root), for the indentation of the folder list. */
export function depthBelow(root: string, path: string): number {
	const r = root.replace(/^\/+|\/+$/g, "");
	if (path === r) return 0;
	const rel = r === "" ? path : path.slice(r.length + 1);
	return rel.split("/").length;
}

/** The next art style after `style` (the cover and folder previews cycle through them). */
export function nextArtStyle(style: CoverArtStyle): CoverArtStyle {
	const i = COVER_ART_STYLES.indexOf(style);
	return COVER_ART_STYLES[(i + 1) % COVER_ART_STYLES.length]!;
}

/** What the dialog's Notebook tab decided. */
export interface NotebookSpec {
	name: string;
	description: string;
	folder: string;
	paper: PaperKind;
	size: SizeChoice;
	customMm: { width: number; height: number };
	landscape: boolean;
	/** Cover colour `#rrggbb` (meta.cover). */
	color: string;
	/** Generated art; an image cover is stored by the host (it needs the vault) and replaces it. */
	art: { style: CoverArtStyle; seed: string };
}

/** The document of a new notebook made from blank pages: one page of the chosen paper and size, with its metadata. */
export function notebookDocument(spec: NotebookSpec, now: Date = new Date()): NotebookDocument {
	const doc = createDocument(now, pageSize(spec.size, spec.landscape, spec.customMm), { kind: spec.paper, spacing: PAPER_SPACING[spec.paper] });
	applyNotebookMeta(doc, spec);
	return doc;
}

/** Sets the colour, description and generated cover of `spec` on `doc` (also for a document made from a template). */
export function applyNotebookMeta(doc: NotebookDocument, spec: Pick<NotebookSpec, "color" | "description" | "art">, cover?: CoverArt): void {
	const meta = doc.meta!;
	meta.cover = spec.color;
	const description = spec.description.trim().slice(0, META_DESCRIPTION_MAX);
	if (description) meta.description = description;
	else delete meta.description;
	meta.coverArt = cover ?? { kind: "art", style: spec.art.style, seed: spec.art.seed };
}
