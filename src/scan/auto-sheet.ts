import type { PickedFile } from "../view/pick";
import { decodePhoto } from "./decode";
import { detectDocument } from "./detect";
import { applyFilter, toGray } from "./filters";
import { outputSize, warpPerspective } from "./geometry";
import type { Quad, ScanFilter } from "./types";

/** A photo cropped and filtered without asking anything: the instant board shot. */
export interface AutoSheet {
	jpeg: ArrayBuffer;
	width: number;
	height: number;
	name: string;
	/** False when no page outline was found and the whole photo was kept. */
	cropped: boolean;
}

/** Longest side of the working copy and of the result (same as the scanner). */
const MAX_WORK_SIDE = 2400;
const JPEG_QUALITY = 0.85;

/** The whole frame as a quad (tl, tr, br, bl): what is used when detection finds nothing. */
export function fullFrameQuad(width: number, height: number): Quad {
	return [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
}

function baseName(name: string): string {
	return name.replace(/\.[^./\\]+$/, "").trim() || "photo";
}

/**
 * Decodes a photo, finds the board or page with the scanner's detection (the whole photo if it finds none), corrects
 * the perspective and applies `filter`. Throws `PhotoDecodeError` (HEIC gets its own reason) when the photo is unreadable.
 */
export async function autoSheet(file: PickedFile, filter: ScanFilter): Promise<AutoSheet> {
	const { canvas: work, ctx: wctx } = await decodePhoto(file.bytes, file.name, MAX_WORK_SIDE, file.type);
	const out = createEl("canvas");
	try {
		const w = work.width;
		const h = work.height;
		const src = wctx.getImageData(0, 0, w, h);
		const found = detectDocument(toGray(src), w, h);
		const corners = found ?? fullFrameQuad(w, h);
		const size = outputSize(corners, MAX_WORK_SIDE);
		const filtered = applyFilter(warpPerspective(src, corners, size.width, size.height), filter);
		out.width = size.width;
		out.height = size.height;
		const octx = out.getContext("2d");
		if (!octx) throw new Error("2D canvas is not available");
		octx.putImageData(new ImageData(new Uint8ClampedArray(filtered.data), filtered.width, filtered.height), 0, 0);
		const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
		if (!blob) throw new Error("could not encode JPEG");
		return { jpeg: await blob.arrayBuffer(), width: size.width, height: size.height, name: `${baseName(file.name)}-board.jpg`, cropped: found !== null };
	} finally {
		work.width = 0;
		work.height = 0;
		out.width = 0;
		out.height = 0;
	}
}
