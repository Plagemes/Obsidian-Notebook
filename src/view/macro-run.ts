// 0.27 macros (#170): runs a macro on a notebook view. The steps go through `view.runAction`, the entry point of every tap, one after the
// other; the whole run is one undo step (History.group), the refusal notices of the History and of the page lock are held back and counted
// instead, and the run ends with ONE notice: what was done, or which step stopped it and why.
import { t } from "../i18n";
import { runMacro, type Macro, type MacroResult } from "../ui/macros";
import { stepText } from "./macros-modal";
import { showNotice } from "./notice";
import type { NotebookView } from "./notebook-view";

/** Views a macro is running on now (a macro never starts inside another run). */
const running = new WeakSet<object>();

/** The one notice a run ends with. */
export function macroNotice(macro: Macro, result: MacroResult): string {
	if (result.ok) {
		const vars = { name: macro.name, n: String(result.ran), skipped: String(result.skipped) };
		return t(result.skipped > 0 ? "macros.ran.skipped" : "macros.ran", vars);
	}
	if (result.reason === "empty") return t("macros.nothing", { name: macro.name });
	const tail = result.done > 0 ? t("macros.failed.tail.some", { done: String(result.done) }) : t("macros.failed.tail.none");
	const step = macro.steps[result.step];
	return t(`macros.failed.${result.reason}`, { name: macro.name, n: String(result.step + 1), step: step ? stepText(step) : "", tail });
}

/** Runs `macro` on `view`; null when one is already running there. */
export function runMacroOn(view: NotebookView, macro: Macro): MacroResult | null {
	if (running.has(view)) {
		showNotice(t("macros.busy"));
		return null;
	}
	running.add(view);
	try {
		const result = runMacro(macro, {
			context: () => view.uiContext(),
			applies: (id) => view.commandApplies(id),
			run: (id, arg) => view.runAction(id, arg),
			refusals: () => view.editRefusals,
			group: (label, fn) => view.runGrouped(label, fn),
		});
		showNotice(macroNotice(macro, result), result.ok ? 4000 : 9000);
		return result;
	} finally {
		running.delete(view);
	}
}
