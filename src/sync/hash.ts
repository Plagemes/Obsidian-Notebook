/** 0.22 (roadmap #126): SHA-256 of a file's bytes as lower-case hex, with the Web Crypto API (WebView, Electron and Node alike). */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	let out = "";
	for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
	return out;
}
