// wave 0.10 (81): the sentence for a page range that cannot be used (export and print dialog).
import { t } from "../i18n";
import type { PageRangeResult } from "../model/page-range";

/** The text that says what is wrong with a typed page range, or null when it is fine. */
export function rangeProblem(result: PageRangeResult, count: number): string | null {
	if (result.ok) return null;
	switch (result.error) {
		case "empty": return t("export.range.empty");
		case "syntax": return t("export.range.syntax", { text: result.text ?? "" });
		case "backwards": return t("export.range.backwards", { text: result.text ?? "" });
		default: return t("export.range.outOfRange", { n: String(result.page ?? 0), count: String(count) });
	}
}
