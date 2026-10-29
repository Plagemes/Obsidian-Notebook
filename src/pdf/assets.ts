import type { AssetKind } from "../model/types";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"] as const;

/** Name of the assets folder inside the notebooks folder. */
export const ASSETS_DIRNAME = "_assets";

/** Lowercase extension without the dot, or "". */
function extensionOf(name: string): string {
	const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Kind of asset a file name denotes (by extension), or null when unsupported. */
export function kindFromName(name: string): AssetKind | null {
	const ext = extensionOf(name);
	if (ext === "pdf") return "pdf";
	return (IMAGE_EXTENSIONS as readonly string[]).includes(ext) ? "image" : null;
}

/** Extension (no dot) to store an asset under: from the name when valid for the kind, else "pdf" / "png". */
export function assetExtension(kind: AssetKind, originalName: string): string {
	if (kind === "pdf") return "pdf";
	const ext = extensionOf(originalName);
	return (IMAGE_EXTENSIONS as readonly string[]).includes(ext) ? ext : "png";
}

/** `<id>.<ext>`: content-addressed file name. */
export function assetFileName(id: string, kind: AssetKind, originalName: string): string {
	return `${id}.${assetExtension(kind, originalName)}`;
}

/** `<notebooks folder>/_assets` (the folder may be "" for the vault root). */
export function assetsFolder(notebooksFolder: string): string {
	const base = notebooksFolder.replace(/^\/+|\/+$/g, "");
	return base ? `${base}/${ASSETS_DIRNAME}` : ASSETS_DIRNAME;
}

/** Vault path of an asset: `<folder>/<id>.<ext>` (`ext` with or without the leading dot). */
export function assetPath(folder: string, id: string, ext: string): string {
	const dir = folder.replace(/\/+$/g, "");
	const e = ext.replace(/^\./, "");
	return `${dir ? dir + "/" : ""}${id}.${e}`;
}
