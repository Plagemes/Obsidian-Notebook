import type { InputSettings } from "../ink/input-policy";
import { effectivePenHold } from "../ink/pen-button";
import type { NotebookSettings } from "../settings";

/** The input-policy view of the plugin settings. */
export function policySettings(s: NotebookSettings): InputSettings {
	return {
		fingerDrawing: s.fingerDrawing,
		palmRejectionMs: s.palmRejectionMs,
		palmContactPx: s.palmContactPx,
		edge: { enabled: s.edgeRejection, widthPx: s.edgeRejectionPx, left: s.edgeLeft, right: s.edgeRight, top: s.edgeTop, bottom: s.edgeBottom },
		penButton: s.penSideButton,
		penLongPress: effectivePenHold(s.penHoldStill, s.penButtonSeen),
		fingerLongPress: s.fingerLongPress,
		zeroPressureButton: s.penZeroPressureButton,
		chordButton: s.penChordButton,
	};
}
