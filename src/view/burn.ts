// 0.26 redact (#285): burns redaction boxes into the picture of a page's background (a PDF page or a scan). The rectangles come from
// ink/redact.ts (`burnPixelRects`); this file only paints them. The picture it is given is never changed: the copy is the one that is
// encoded, so a PDF page held in the cache of the PDF store keeps its pixels.

/** Width and height in pixels of anything the canvas can draw. */
export function sourceSize(source: CanvasImageSource): { width: number; height: number } {
	const s = source as { width?: number; height?: number; displayWidth?: number; displayHeight?: number; videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number };
	return {
		width: Math.max(1, Math.round(s.displayWidth ?? s.videoWidth ?? s.naturalWidth ?? s.width ?? 1)),
		height: Math.max(1, Math.round(s.displayHeight ?? s.videoHeight ?? s.naturalHeight ?? s.height ?? 1)),
	};
}

/** A new canvas holding `source` at `width` × `height` pixels with the rectangles painted solid black. Throws when no canvas is available. */
export function burnedCanvas(source: CanvasImageSource, width: number, height: number, rects: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): HTMLCanvasElement {
	const canvas = createEl("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas 2D is not available");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, width, height);
	ctx.drawImage(source, 0, 0, width, height);
	ctx.fillStyle = "#000000";
	for (const r of rects) ctx.fillRect(r.x, r.y, r.width, r.height);
	return canvas;
}
