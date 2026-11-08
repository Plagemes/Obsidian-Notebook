/**
 * The runtime `Http` of the cloud connector (#126): Obsidian's `requestUrl`, which is not bound by CORS on Android or on
 * desktop. `throw: false` so every status comes back as an answer; only a request with no answer rejects.
 */
import { requestUrl } from "obsidian";
import type { Http, HttpResponse } from "./http";

export function obsidianHttp(): Http {
	return {
		async request(req): Promise<HttpResponse> {
			const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, contentType: req.contentType, throw: false });
			let text: string | undefined;
			return {
				status: res.status,
				headers: res.headers ?? {},
				// Decoded only when read: a downloaded file is never turned into text.
				get text(): string {
					if (text === undefined) {
						try {
							text = res.text;
						} catch {
							text = "";
						}
					}
					return text;
				},
				arrayBuffer: res.arrayBuffer,
			};
		},
	};
}
