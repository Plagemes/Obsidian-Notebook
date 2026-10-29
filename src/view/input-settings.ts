import type { InputSettings } from "../ink/input-policy";
import type { NotebookSettings } from "../settings";

/** The input-policy view of the plugin settings. */
export function policySettings(s: NotebookSettings): InputSettings {
	return {
		fingerDrawing: s.fingerDrawing,
		palmRejectionMs: s.palmRejectionMs,
		palmContactPx: s.palmContactPx,
		edge: { enabled: s.edgeRejection, widthPx: s.edgeRejectionPx, left: s.edgeLeft, right: s.edgeRight, top: s.edgeTop, bottom: s.edgeBottom },
		penButton: s.penButtonAction,
	};
}
