// 0.27 macros (#170): the one notice a macro run ends with. Pure (the text of a step is given), so the wording is unit-tested in Node.
import { t } from "../i18n";
import type { Macro, MacroResult, MacroStep } from "./macros";

/** The sentence about steps that ran but changed nothing (empty when there are none). */
function noEffectNote(n: number | undefined): string {
	if (!n) return "";
	return " " + (n === 1 ? t("macros.noEffect.one") : t("macros.noEffect.n", { n: String(n) }));
}

/** The one notice a run ends with: what was done, or which step stopped it and why. `stepText` names a step ("Paper: Grid"). */
export function macroNotice(macro: Macro, result: MacroResult, stepText: (step: MacroStep) => string): string {
	if (result.ok) {
		if (result.ran === 0 && result.noEffect) {
			// Review fix (R6): singular / plural, and the steps that were skipped are still said.
			const base = t(result.noEffect === 1 ? "macros.noChange.one" : "macros.noChange", { name: macro.name, n: String(result.noEffect) });
			return result.skipped > 0 ? `${base} ${t("macros.skippedNote", { skipped: String(result.skipped) })}` : base;
		}
		const vars = { name: macro.name, n: String(result.ran), skipped: String(result.skipped) };
		return t(result.skipped > 0 ? "macros.ran.skipped" : "macros.ran", vars) + noEffectNote(result.noEffect);
	}
	if (!("step" in result)) return t(result.reason === "empty" ? "macros.nothing" : "macros.writing", { name: macro.name });
	const tail = (result.done > 0 ? t("macros.failed.tail.some", { done: String(result.done) }) : t("macros.failed.tail.none")) + noEffectNote(result.noEffect);
	const step = macro.steps[result.step];
	return t(`macros.failed.${result.reason}`, { name: macro.name, n: String(result.step + 1), step: step ? stepText(step) : "", tail });
}
