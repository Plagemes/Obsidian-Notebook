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
		// The long-press gesture trigger takes the resting pen: the hold-still radial menu would fight it.
		penLongPress: effectivePenHold(s.penHoldStill, s.penButtonSeen) && !s.penGestureLongPress,
		restGesture: s.penGestureLongPress,
		fingerLongPress: s.fingerLongPress,
		zeroPressureButton: s.penZeroPressureButton,
		chordButton: s.penChordButton,
		eraserNextOnClick: s.penButtonEraserNext,
		buttonWindows: { beforeMs: s.penButtonContactBeforeMs, afterMs: s.penButtonContactAfterMs },
	};
}
