/** Pure image-math types: no DOM, testable in Node. */
export interface Pt {
	x: number;
	y: number;
}

/** Quadrilateral corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];

/** Structural subset of the DOM `ImageData` (RGBA, 8 bits per channel). */
export interface ImageDataLike {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

export type ScanFilter = "original" | "document" | "whiteboard";
