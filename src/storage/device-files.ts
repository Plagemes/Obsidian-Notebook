/**
 * Small sidecar files kept **one per device** in the notebooks folder's reserved `_meta` folder (`<prefix>-<device>.json`,
 * like the Inbox files): a device only ever writes its own file, so two synced devices never write the same file and the
 * sync service has nothing to conflict on; reading merges every device's file. Pure helpers, no 'obsidian': the vault is
 * reached through an adapter.
 */
import type { LinkFileAdapter } from "./pdf-links-store";

export interface DeviceFileAdapter extends LinkFileAdapter {
	/** Paths of the files directly inside `folder` (empty when it does not exist). */
	list(folder: string): Promise<string[]>;
	/** Size in bytes of the file (null when there is none); lets a reader skip a file far bigger than it can be. */
	size?(path: string): Promise<number | null>;
}

/**
 * Why an existing file that is empty (or only white space) is not read as "no data": a sync app that has not finished
 * downloading it, or a write cut short, leaves exactly that, and writing over it would lose what it held.
 */
export const EMPTY_FILE_MESSAGE = "the file is empty: it may not have finished syncing yet. Nothing was changed; try again once it has synced";

/** `<prefix>-<device>.json` */
export function deviceFileName(prefix: string, device: string): string {
	return `${prefix}-${device}.json`;
}

/** The device id of a file name made by `deviceFileName(prefix, …)`, or null. */
export function deviceOfFileName(prefix: string, name: string): string | null {
	if (!name.startsWith(`${prefix}-`)) return null;
	const m = /^([0-9a-f]{8})\.json$/.exec(name.slice(prefix.length + 1));
	return m ? m[1]! : null;
}

export function textHash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/** Creates every missing folder along `folder`. */
export async function ensureFolderPath(adapter: LinkFileAdapter, folder: string): Promise<void> {
	let current = "";
	for (const part of folder.split("/").filter(Boolean)) {
		current = current ? `${current}/${part}` : part;
		if (!(await adapter.exists(current))) await adapter.mkdir(current);
	}
}

/** One copy of an unreadable file, named by its content (`<prefix>.unreadable-<hash>.json`), so repeated failures do not pile up files. */
export async function keepUnreadableCopy(adapter: LinkFileAdapter, folder: string, prefix: string, text: string): Promise<void> {
	const copy = `${folder}/${prefix}.unreadable-${textHash(text)}.json`;
	try {
		if (!(await adapter.exists(copy))) await adapter.write(copy, text);
	} catch {
		/* the original is untouched either way */
	}
}

/** The device files of `prefix` in `folder`, with their device ids. */
export async function listDeviceFiles(adapter: DeviceFileAdapter, folder: string, prefix: string): Promise<Array<{ path: string; device: string }>> {
	const out: Array<{ path: string; device: string }> = [];
	for (const path of await adapter.list(folder)) {
		const device = deviceOfFileName(prefix, path.slice(path.lastIndexOf("/") + 1));
		if (device) out.push({ path, device });
	}
	return out.sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
}
