/**
 * S Pen fallbacks for Obsidian's Android app (0.11.2): pure decision logic, no DOM and no `obsidian`.
 *
 * What the device showed (Samsung tablet, S Pen, Obsidian for Android, logged with the Pen button test):
 *   - stylus hover never reaches Obsidian's WebView (Chrome on the same device gets it);
 *   - the side button clicked while hovering leaves ONE `contextmenu`: no `pointerType`, `button` -1, `buttons` 0,
 *     derived from touch, no release, and no pointer event in progress;
 *   - with the nib touching, full pointer events arrive (pressure, `buttons`).
 * So a `contextmenu` that no pointer on the view explains is the side button clicked while hovering. A finger
 * long-press also ends in a `contextmenu`, but while the finger is down (or right after a long contact): that one
 * keeps its behaviour. A key (F9 to F12, or any key captured in the settings) can stand in for the button, for people
 * who map the S Pen to a key with Key Mapper and Shizuku.
 */

/** A `contextmenu` this soon after a long finger contact ended is that finger's long-press (some WebViews send it on lift). */
export const LONG_PRESS_AFTER_MS = 600;
/** A finger contact at least this long is a long-press candidate (Android's long-press timeout is 400 to 500 ms). */
export const LONG_CONTACT_MS = 350;
/** A right click of a mouse fires `contextmenu` on release on Windows: one this soon after a mouse button is the mouse's. */
export const MOUSE_AFTER_MS = 600;
/** A pointer that sent nothing for this long is gone (its up was swallowed by a menu, or never sent). */
export const STALE_POINTER_MS = 5000;
/**
 * A finger or palm on the view, or one that touched it this recently, explains a bare `contextmenu` during a pen stroke
 * (a palm long-press while writing): it is never the side button then, ms.
 */
export const TOUCH_RECENT_MS = 600;

export type HoverPointerKind = "down" | "move" | "up" | "cancel";

/**
 * What a `contextmenu` over the notebook view is:
 *   - `hover-click`: no pointer explains it: the pen's side button clicked while hovering (or a keyboard menu key);
 *   - `long-press`: a finger is down, or a long finger contact has just ended;
 *   - `pointer`: a pen (or mouse) is touching: the existing side-button detection judges it;
 *   - `mouse`: a mouse right click;
 *   - `text`: a text field has the focus or is the target: its own menu (paste, select) stays.
 */
export type ContextMenuKind = "hover-click" | "long-press" | "pointer" | "mouse" | "text";

interface Tracked {
	type: string;
	downT: number;
	seenT: number;
}

/**
 * Which pointers are down on the view, and how the last ones ended, to tell the side button clicked while hovering
 * (no pointer at all) from a finger long-press. Fed with every pointer event over the view; feeding the same event
 * twice (window watch and element) changes nothing.
 */
export class HoverClickTracker {
	private readonly down = new Map<number, Tracked>();
	private lastTouchUpT = -Infinity;
	private lastTouchContactMs = 0;
	/** Last event of any finger or palm (down, move, up). */
	private lastTouchT = -Infinity;
	private lastMouseT = -Infinity;
	/** The last pen contact: when it landed, and when it lifted (null while it is down). */
	private penDownT = -Infinity;
	private penUpT: number | null = null;

	reset(): void {
		this.down.clear();
		this.lastTouchUpT = -Infinity;
		this.lastTouchContactMs = 0;
		this.lastTouchT = -Infinity;
		this.lastMouseT = -Infinity;
		this.penDownT = -Infinity;
		this.penUpT = null;
	}

	pointer(kind: HoverPointerKind, pointerType: string, pointerId: number, t: number, buttons = 0): void {
		if (pointerType === "mouse" && (kind === "down" || kind === "up")) this.lastMouseT = Math.max(this.lastMouseT, t);
		if (pointerType === "touch") this.lastTouchT = Math.max(this.lastTouchT, t);
		const known = this.down.get(pointerId);
		if (kind === "down") {
			if (!known || known.type !== pointerType) {
				this.down.set(pointerId, { type: pointerType, downT: t, seenT: t });
				if (pointerType === "pen") {
					this.penDownT = t;
					this.penUpT = null;
				}
			} else {
				known.seenT = Math.max(known.seenT, t);
			}
			return;
		}
		if (kind === "move") {
			if (!known) return;
			// A pen or mouse move without the contact bit: it has lifted (its up was swallowed).
			if (pointerType !== "touch" && (buttons & 1) === 0) this.lifted(pointerId, known, t);
			else known.seenT = Math.max(known.seenT, t);
			return;
		}
		if (!known) return;
		this.lifted(pointerId, known, t);
		if (known.type === "touch") {
			this.lastTouchUpT = t;
			this.lastTouchContactMs = t - known.downT;
		}
	}

	private lifted(pointerId: number, known: Tracked, t: number): void {
		this.down.delete(pointerId);
		if (known.type === "pen" && known.downT === this.penDownT) this.penUpT = t;
	}

	/**
	 * When the last pen contact landed, if it has already lifted (at or before `t`) and landed at most `afterMs` before
	 * `t`: a bare `contextmenu` then is the button held at that contact, arriving after the lift of a short flick. Null
	 * otherwise (no such contact, still down, or too long ago).
	 */
	liftedPenContact(t: number, afterMs: number): number | null {
		if (this.penUpT === null || this.penUpT > t) return null;
		const dt = t - this.penDownT;
		return dt >= 0 && dt <= afterMs ? this.penDownT : null;
	}

	/** A finger or palm is on the view at `t`, or touched it less than `TOUCH_RECENT_MS` before. */
	touchRecent(t: number): boolean {
		return this.activeCount(t, "touch") > 0 || t - this.lastTouchT < TOUCH_RECENT_MS;
	}

	/** Pointers of `type` (any type when omitted) down on the view at `t`, stale ones dropped. */
	activeCount(t: number, type?: string): number {
		let n = 0;
		for (const [id, p] of this.down) {
			if (t - p.seenT > STALE_POINTER_MS) {
				this.down.delete(id);
				continue;
			}
			if (type === undefined || p.type === type) n++;
		}
		return n;
	}

	/** What a `contextmenu` at `t` is. `pointerType` is the event's own (undefined for a plain MouseEvent). */
	classify(pointerType: string | undefined, t: number, textFocused: boolean): ContextMenuKind {
		if (textFocused) return "text";
		if (pointerType === "touch") return "long-press";
		if (pointerType === "mouse") return "mouse";
		if (this.activeCount(t, "touch") > 0) return "long-press";
		if (t - this.lastTouchUpT < LONG_PRESS_AFTER_MS && this.lastTouchContactMs >= LONG_CONTACT_MS) return "long-press";
		if (this.activeCount(t) > 0) return "pointer";
		if (t - this.lastMouseT < MOUSE_AFTER_MS) return "mouse";
		return "hover-click";
	}
}

/** A client position and a rectangle in client coordinates. */
export interface ClientPoint {
	x: number;
	y: number;
}
export interface ClientRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

const inside = (p: ClientPoint, r: ClientRect): boolean => p.x >= r.left && p.x <= r.left + r.width && p.y >= r.top && p.y <= r.top + r.height;

/**
 * Where the radial menu opens for a hover click (or the pen key), relative to `rect` (the page area): the event's
 * position if it has one (not 0, 0) inside the area, else the last pen position if it is inside, else the centre.
 */
export function hoverMenuPosition(event: ClientPoint | null, lastPen: ClientPoint | null, rect: ClientRect): ClientPoint {
	const at = (p: ClientPoint): ClientPoint => ({ x: p.x - rect.left, y: p.y - rect.top });
	if (event && (event.x !== 0 || event.y !== 0) && Number.isFinite(event.x) && Number.isFinite(event.y) && inside(event, rect)) return at(event);
	if (lastPen && inside(lastPen, rect)) return at(lastPen);
	return { x: rect.width / 2, y: rect.height / 2 };
}

/**
 * "Next stroke erases": armed by a click of the button (or the pen key), used by the next pen stroke only. A second
 * click disarms it; so do a tool change and Escape.
 */
export class EraserNextArm {
	private on = false;

	constructor(private readonly changed: (armed: boolean) => void = () => {}) {}

	get armed(): boolean {
		return this.on;
	}

	toggle(): boolean {
		this.set(!this.on);
		return this.on;
	}

	disarm(): void {
		this.set(false);
	}

	/** A pen stroke starts: true when it is the armed one (it erases), and the arm is used up. */
	consume(): boolean {
		if (!this.on) return false;
		this.set(false);
		return true;
	}

	private set(on: boolean): void {
		if (on === this.on) return;
		this.on = on;
		this.changed(on);
	}
}

/** What a click of the button while hovering does: the radial menu, arm the eraser for the next stroke, or nothing. */
export type HoverClickAction = "menu" | "eraser-next" | "none";

/** `eraserNext`: the setting "Button click: next stroke erases"; `opensMenu`: the side-button action opens the radial menu; `off`: it is "Nothing". */
export function hoverClickAction(f: { eraserNext: boolean; opensMenu: boolean; off: boolean }): HoverClickAction {
	if (f.off) return "none";
	if (f.eraserNext) return "eraser-next";
	return f.opensMenu ? "menu" : "none";
}

// --- the pen key (Key Mapper + Shizuku) ---

export const PEN_KEY_ACTIONS = ["menu", "eraser-next"] as const;
export type PenKeyAction = (typeof PEN_KEY_ACTIONS)[number];
/** The keys offered in the settings; any other key can be captured. */
export const PEN_KEY_PRESETS = ["F9", "F10", "F11", "F12"] as const;

export function isPenKeyAction(v: unknown): v is PenKeyAction {
	return PEN_KEY_ACTIONS.includes(v as PenKeyAction);
}

/** A saved key name: '' (off) or a short single-line name. */
export function cleanPenKey(v: unknown): string | null {
	if (typeof v !== "string") return null;
	if (v.length > 32 || /[\r\n\t]/.test(v)) return null;
	return v;
}

export interface KeyFacts {
	key?: string;
	code?: string;
	repeat?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	isComposing?: boolean;
}

/** The name a key is saved and matched by: `key`, or `code` when the key is unidentified. */
export function keyName(e: KeyFacts): string {
	if (e.key && e.key !== "Unidentified" && e.key !== "Dead") return e.key;
	return e.code ?? "";
}

/** Keys that cannot be the pen key: modifiers alone, Escape (it cancels the capture and disarms), Tab and Enter (focus and forms). */
const NOT_CAPTURABLE = new Set(["", "Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "CapsLock", "Fn", "FnLock", "Escape", "Tab", "Enter"]);

/** The key a press captures in the settings, or null when it cannot be the pen key. */
export function capturedKey(e: KeyFacts): string | null {
	const name = keyName(e);
	if (NOT_CAPTURABLE.has(name) || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return null;
	return cleanPenKey(name) || null;
}

/** Is this key press the pen key (`saved`, '' = off)? Never a repeat, never with Ctrl, Alt or Meta (those are shortcuts). */
export function penKeyMatches(e: KeyFacts, saved: string): boolean {
	if (!saved || e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return false;
	const name = keyName(e);
	if (name === saved) return true;
	return saved.length === 1 && name.length === 1 && name.toLowerCase() === saved.toLowerCase();
}

/** Where the pen key was pressed. */
export interface PenKeyScene {
	/** This notebook view is the active one. */
	viewActive: boolean;
	/** An input, textarea or contenteditable has the focus. */
	textFocused: boolean;
	/** A modal dialog is open (the settings, the pen button test, ...). */
	modalOpen: boolean;
}

export function penKeyMayAct(scene: PenKeyScene): boolean {
	return scene.viewActive && !scene.textFocused && !scene.modalOpen;
}

/** Is the focused element (or the target) a text field: input, textarea, select or contenteditable? */
export function isTextField(el: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
	if (!el) return false;
	if (el.isContentEditable === true) return true;
	const tag = (el.tagName ?? "").toUpperCase();
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Commands of Obsidian's hotkey manager bound to `key` without modifiers. `manager` is `app.hotkeyManager`, which is not
 * part of the public API: it is read defensively (custom keys first, then defaults of commands without custom keys) and
 * anything unexpected gives no conflict.
 */
export function hotkeyConflicts(manager: unknown, key: string): string[] {
	if (!key || typeof manager !== "object" || manager === null) return [];
	const m = manager as { customKeys?: unknown; defaultKeys?: unknown };
	const custom = asHotkeyTable(m.customKeys);
	const defaults = asHotkeyTable(m.defaultKeys);
	const found: string[] = [];
	const check = (id: string, list: unknown) => {
		if (!Array.isArray(list)) return;
		for (const h of list as unknown[]) {
			if (typeof h !== "object" || h === null) continue;
			const hk = h as { key?: unknown; modifiers?: unknown };
			const mods = Array.isArray(hk.modifiers) ? hk.modifiers : [];
			if (typeof hk.key !== "string" || mods.length > 0) continue;
			if (hk.key === key || (key.length === 1 && hk.key.toLowerCase() === key.toLowerCase())) {
				if (!found.includes(id)) found.push(id);
				return;
			}
		}
	};
	for (const [id, list] of Object.entries(custom)) check(id, list);
	for (const [id, list] of Object.entries(defaults)) if (!(id in custom)) check(id, list);
	return found;
}

function asHotkeyTable(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// --- Capacitor inventory (Pen button test) ---

/** What the Pen button test reports about the Capacitor bridge: names only, nothing is called. */
export interface CapacitorInventory {
	present: boolean;
	platform?: string | null;
	headers?: Record<string, string[]>;
	headersErr?: string;
	pluginKeys?: string[];
	pluginsErr?: string;
	globals?: string[];
}

interface CapacitorMethodHeader {
	name?: unknown;
	rtype?: unknown;
}
interface CapacitorPluginHeader {
	name?: unknown;
	methods?: unknown;
}
interface CapacitorLike {
	getPlatform?: unknown;
	PluginHeaders?: unknown;
	Plugins?: unknown;
}

/**
 * Read-only inventory of `window.Capacitor`: the platform, the plugin headers (method names and return types), the
 * plugin keys and the window globals whose names suggest a native bridge. It reads headers and keys only: it never
 * calls a plugin. `getPlatform()` is the one function called (a getter of a constant string).
 */
export function capacitorInventory(win: object): CapacitorInventory {
	const c = (win as { Capacitor?: unknown }).Capacitor;
	if (typeof c !== "object" || c === null) return { present: false };
	const cap = c as CapacitorLike;
	const o: CapacitorInventory = { present: true, platform: null, headers: {}, pluginKeys: [], globals: [] };
	try {
		if (typeof cap.getPlatform === "function") {
			const p: unknown = (cap.getPlatform as () => unknown).call(c);
			o.platform = typeof p === "string" ? p : null;
		}
	} catch {
		o.platform = null;
	}
	try {
		const headers = Array.isArray(cap.PluginHeaders) ? (cap.PluginHeaders as unknown[]) : [];
		for (const h of headers) {
			if (typeof h !== "object" || h === null) continue;
			const ph = h as CapacitorPluginHeader;
			const methods = Array.isArray(ph.methods) ? (ph.methods as unknown[]) : [];
			o.headers![String(ph.name)] = methods.map((m) => {
				const mh = (typeof m === "object" && m !== null ? m : {}) as CapacitorMethodHeader;
				return `${String(mh.name)}:${String(mh.rtype)}`;
			});
		}
	} catch (e) {
		o.headersErr = String(e);
	}
	try {
		o.pluginKeys = typeof cap.Plugins === "object" && cap.Plugins !== null ? Object.keys(cap.Plugins) : [];
	} catch (e) {
		o.pluginsErr = String(e);
	}
	try {
		o.globals = Object.getOwnPropertyNames(win).filter((k) => /bridge|android|capacitor|native|spen|stylus/i.test(k));
	} catch {
		// Some globals cannot be listed: the line just shows none.
	}
	return o;
}

/** The inventory as one log line. */
export function formatCapacitorInventory(o: CapacitorInventory): string {
	if (!o.present) return "Capacitor: not present";
	const headers = Object.entries(o.headers ?? {}).map(([k, v]) => `${k}[${v.join(",")}]`).join(" ");
	const parts = [`Capacitor: platform=${o.platform ?? "-"}`, `plugins=${(o.pluginKeys ?? []).join(",") || "-"}`, `headers=${headers || "-"}`, `globals=${(o.globals ?? []).join(",") || "-"}`];
	if (o.headersErr) parts.push(`headersErr=${o.headersErr}`);
	if (o.pluginsErr) parts.push(`pluginsErr=${o.pluginsErr}`);
	return parts.join(" ");
}

// --- the button seen only as a contextmenu around a pen contact (0.11.2, device finding) ---

/**
 * On the user's tablet the pen's pointer events never show the side button (`buttons` stays 1). Its only trace is a
 * `contextmenu` (empty `pointerType`, `button` -1, `buttons` 0, `isPrimary` false) that fires:
 *   - just before or just after the pen's `pointerdown` when the button is held and the nib then touches;
 *   - during a stroke when the button is pressed while writing;
 *   - on its own when the button is clicked while the pen hovers.
 * The windows say how close to the pen's `pointerdown` the contextmenu must be to mean "button held at contact".
 */
export interface ButtonWindows {
	/** A contextmenu at most this long BEFORE the pen's pointerdown: that contact is the eraser, ms. */
	beforeMs: number;
	/** A contextmenu at most this long AFTER the pen's pointerdown: that contact is the eraser from its start, ms. */
	afterMs: number;
}
export const DEFAULT_BUTTON_WINDOWS: Readonly<ButtonWindows> = { beforeMs: 150, afterMs: 350 };
export const BUTTON_BEFORE_MAX_MS = 500;
/**
 * The after-window never reaches Android's long-press timeout (about 400 to 500 ms): a longer one would let the
 * `contextmenu` of a resting nib's long-press pass for the button held at contact.
 */
export const BUTTON_AFTER_MAX_MS = 400;

/** A window setting: a whole number of ms from 0, clamped to `max` (an older, larger value reads as `max`), else null. */
export function cleanWindowMs(v: unknown, max: number): number | null {
	return typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null;
}

/** The windows as used: each clamped to [0, its maximum] (settings saved by an older version may hold more). */
export function clampWindows(w: ButtonWindows): ButtonWindows {
	const clamp = (v: number, max: number) => (Number.isFinite(v) ? Math.min(Math.max(0, v), max) : 0);
	return { beforeMs: clamp(w.beforeMs, BUTTON_BEFORE_MAX_MS), afterMs: clamp(w.afterMs, BUTTON_AFTER_MAX_MS) };
}

export type ContactButtonVerdict = "held-at-contact" | "during-stroke" | "hovering" | "none";

/**
 * CSS px the nib may drift and still count as resting, to tell a nib long-press from the button. Above Android's touch
 * slop (8 dp), which its long-press tolerates: in the WebView one CSS px is one dp (`devicePixelRatio` is the screen
 * density), so no further scaling applies. Wider than the hold-still menu's `HOLD_RADIUS_PX`, which serves another purpose.
 */
export const STILL_RADIUS_PX = 12;
/** A nib resting still this long (ms) when a `contextmenu` comes is a long-press, even inside the after-window. */
export const NIB_LONG_PRESS_MS = LONG_CONTACT_MS;

export const VERDICT_TEXT: Record<ContactButtonVerdict, string> = {
	"held-at-contact": "button held at contact",
	"during-stroke": "button during stroke",
	hovering: "button while hovering",
	none: "not the button",
};

/**
 * A `contextmenu` while the pen touches, `dt` ms after its pointerdown. A nib that has rested still (within
 * `STILL_RADIUS_PX`) since it landed, for at least `NIB_LONG_PRESS_MS`, is a long-press of the nib, not the button,
 * whatever the windows. Otherwise, within the after-window (at most `BUTTON_AFTER_MAX_MS`): the button was held when the
 * nib landed (the whole stroke erases). Later: pressed while writing (the rest erases), unless the nib has rested still.
 */
export function contactVerdict(dt: number, still: boolean, w: ButtonWindows = DEFAULT_BUTTON_WINDOWS): ContactButtonVerdict {
	if (still && dt >= NIB_LONG_PRESS_MS) return "none";
	if (dt <= Math.min(w.afterMs, BUTTON_AFTER_MAX_MS)) return "held-at-contact";
	return still ? "none" : "during-stroke";
}

/** A contextmenu at `menuT` with no contact, then the pen's pointerdown at `downT`: the button was held when it landed? */
export function heldBeforeContact(menuT: number, downT: number, w: ButtonWindows = DEFAULT_BUTTON_WINDOWS): boolean {
	const d = downT - menuT;
	return d >= 0 && d <= w.beforeMs;
}

/** "+42 ms" / "-30 ms". */
export function formatDelta(ms: number): string {
	const r = Math.round(ms);
	return `${r >= 0 ? "+" : ""}${r} ms`;
}

/**
 * The order and the gaps between the pen's pointerdown, a `contextmenu` and the first pointermove, for the Pen button
 * test: each call returns the note for the line it logs (or null), and `verdict` is the latest verdict.
 */
export class ButtonTimeline {
	private downT: number | null = null;
	private moved = false;
	private menuT: number | null = null;
	/** Where the nib landed, and whether it has stayed within `STILL_RADIUS_PX` of it (a resting nib: a long-press). */
	private ox = 0;
	private oy = 0;
	private still = true;
	verdict: ContactButtonVerdict | null = null;

	constructor(private readonly w: ButtonWindows = DEFAULT_BUTTON_WINDOWS) {}

	reset(): void {
		this.downT = null;
		this.moved = false;
		this.menuT = null;
		this.verdict = null;
	}

	penDown(t: number, x = 0, y = 0): string | null {
		this.downT = t;
		this.moved = false;
		this.ox = x;
		this.oy = y;
		this.still = true;
		if (this.menuT !== null && heldBeforeContact(this.menuT, t, this.w)) {
			const d = t - this.menuT;
			this.menuT = null;
			this.verdict = "held-at-contact";
			return `pen down Δ=${formatDelta(d)} after contextmenu: ${VERDICT_TEXT["held-at-contact"]}`;
		}
		this.menuT = null;
		return null;
	}

	penMove(t: number, x?: number, y?: number): string | null {
		if (this.downT === null) return null;
		if (x !== undefined && y !== undefined && Math.hypot(x - this.ox, y - this.oy) > STILL_RADIUS_PX) this.still = false;
		if (this.moved) return null;
		this.moved = true;
		return `first pointermove Δ=${formatDelta(t - this.downT)} after pen down`;
	}

	penUp(): void {
		this.downT = null;
	}

	contextMenu(t: number): string {
		if (this.downT !== null) {
			const dt = t - this.downT;
			this.verdict = contactVerdict(dt, this.still, this.w);
			return `contextmenu Δ=${formatDelta(dt)} after pen down: ${VERDICT_TEXT[this.verdict]}`;
		}
		this.menuT = t;
		this.verdict = "hovering";
		return `contextmenu, no pen contact: ${VERDICT_TEXT.hovering} (unless a pen down follows within ${this.w.beforeMs} ms)`;
	}
}
