import type { ButtonComponent } from "obsidian";

/**
 * Styles `b` as a destructive button (delete, remove). Obsidian 1.13 added `setDestructive()` and deprecated
 * `setWarning()`. Older versions (minAppVersion is 1.8.7) have no `setDestructive()`: there the button gets the
 * `mod-warning` class, which is what `setWarning()` adds and what the plugin's other warning buttons already use.
 */
export function setDestructive(b: ButtonComponent): ButtonComponent {
	const modern = (b as { setDestructive?: () => ButtonComponent }).setDestructive;
	if (typeof modern === "function") return modern.call(b);
	b.buttonEl.addClass("mod-warning");
	return b;
}
