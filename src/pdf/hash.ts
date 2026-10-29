/** SHA-256 of `data` as lowercase hex, via Web Crypto (browsers, the Android WebView, Node 20+). */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(digest);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
	return hex;
}

/** Number of hex chars of the hash used as asset id (96 bits: collisions are not a practical concern). */
export const ASSET_ID_LENGTH = 24;

/** Asset id = first 24 hex chars of the content hash. */
export function assetIdFromHash(hex: string): string {
	return hex.slice(0, ASSET_ID_LENGTH);
}
