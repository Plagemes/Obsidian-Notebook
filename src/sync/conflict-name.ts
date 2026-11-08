/**
 * 0.22 (roadmap #126): the name of the copy that keeps the cloud's version when both sides changed. Pure.
 *
 * `Notes.notebook` -> `Notes (conflict 2026-11-08 14.05 Tablet).notebook`, in the same folder. The pattern is one the #122
 * conflicted-copy check already recognises (`Name (… conflict …)`, src/storage/conflicts.ts), and the copy is the same
 * notebook (same document id), so the existing merge offer finds it and the user merges with the existing dialog. Other files
 * get the same clear suffix and are simply kept side by side.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** Local date and time as "2026-11-08 14.05". */
export function conflictStamp(at: Date): string {
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
}

/** A device label safe inside the parentheses of a file name: no brackets, slashes or reserved characters, at most 24 characters. */
export function deviceLabel(name: string): string {
	return name.replace(/[()[\]{}/\\:*?"<>|#^\n\r\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 24).trim();
}

/**
 * The path of the conflicted copy of `path`. `taken` says whether a path is already used (by a file of either side); a counter
 * is added inside the parentheses until the name is free.
 */
export function conflictCopyPath(path: string, at: Date, device: string, taken: (path: string) => boolean): string {
	const slash = path.lastIndexOf("/");
	const folder = slash >= 0 ? path.slice(0, slash + 1) : "";
	const name = path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	const label = deviceLabel(device);
	const base = `conflict ${conflictStamp(at)}${label ? ` ${label}` : ""}`;
	for (let n = 1; n < 1000; n++) {
		const candidate = `${folder}${stem} (${base}${n > 1 ? ` ${n}` : ""})${ext}`;
		if (!taken(candidate)) return candidate;
	}
	return `${folder}${stem} (${base} ${at.getTime()})${ext}`;
}
