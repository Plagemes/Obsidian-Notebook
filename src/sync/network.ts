/**
 * 0.22 (roadmap #126): may a sync run on the current network? Pure (the caller passes `navigator`).
 *
 * The Network Information API (`navigator.connection.type`) exists in Chrome on Android (Obsidian's WebView) and is missing
 * elsewhere (desktop Electron reports no type). A known metered type stops a "Wi-Fi only" run; an unknown type is allowed, and
 * the status says the network type could not be checked.
 */

export type NetworkVerdict =
	/** Fine (Wi-Fi, Ethernet, or "Wi-Fi only" is off). */
	| "ok"
	/** Allowed, but the network type is unknown: "Wi-Fi only" could not be checked. */
	| "unknown"
	/** A mobile (metered) network while "Wi-Fi only" is on: not now. */
	| "metered"
	/** No network. */
	| "offline";

export interface NavigatorLike {
	onLine?: boolean;
	connection?: { type?: unknown };
}

const METERED = new Set(["cellular", "bluetooth", "wimax"]);
const UNMETERED = new Set(["wifi", "ethernet"]);

export function networkVerdict(nav: NavigatorLike | undefined, wifiOnly: boolean): NetworkVerdict {
	if (nav?.onLine === false) return "offline";
	const type = typeof nav?.connection?.type === "string" ? nav.connection.type : null;
	if (type === "none") return "offline";
	if (!wifiOnly) return "ok";
	if (type !== null && METERED.has(type)) return "metered";
	if (type !== null && UNMETERED.has(type)) return "ok";
	return "unknown";
}
