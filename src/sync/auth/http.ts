/**
 * The small HTTP seam of the cloud connector (#126). Runtime code sends every request through Obsidian's `requestUrl`
 * (see `http-obsidian.ts`: no CORS on Android or desktop); tests pass a fake. Pure: no `obsidian` import.
 *
 * Nothing here logs a request: headers and bodies carry tokens.
 */

export interface HttpRequest {
	url: string;
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	headers?: Record<string, string>;
	/** A string (JSON, form) or raw bytes. */
	body?: string | ArrayBuffer;
	/** Content-Type of the body. */
	contentType?: string;
}

export interface HttpResponse {
	status: number;
	/** Response headers; names may come in any case (use `header()`). */
	headers: Record<string, string>;
	/** The body as text ("" when none). */
	text: string;
	/** The body as bytes. */
	arrayBuffer: ArrayBuffer;
}

/** Sends one request. Resolves for every HTTP status; rejects only when no response came (network, DNS, TLS). */
export interface Http {
	request(req: HttpRequest): Promise<HttpResponse>;
}

/** A header of a response, whatever the case of its name. */
export function header(res: HttpResponse, name: string): string | undefined {
	const want = name.toLowerCase();
	for (const [k, v] of Object.entries(res.headers)) if (k.toLowerCase() === want) return v;
	return undefined;
}

/** The body parsed as JSON, or undefined when it is not JSON. */
export function json(res: HttpResponse): unknown {
	if (!res.text) return undefined;
	try {
		return JSON.parse(res.text) as unknown;
	} catch {
		return undefined;
	}
}

/** `application/x-www-form-urlencoded` body of a token request. */
export function formBody(fields: Record<string, string | undefined>): string {
	return Object.entries(fields)
		.filter((e): e is [string, string] => e[1] !== undefined)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
}

export const FORM = "application/x-www-form-urlencoded";
export const JSON_TYPE = "application/json; charset=UTF-8";

/** A plain object view of an unknown JSON value (never null). */
export function obj(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

export function num(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return undefined;
}

/** The OAuth / API error code of a response body (`error` as a string, or `error.code` / `error.errors[0].reason`). */
export function errorCode(res: HttpResponse): string | undefined {
	const body = obj(json(res));
	const e = body.error;
	if (typeof e === "string") return e;
	const eo = obj(e);
	const reasons = Array.isArray(eo.errors) ? eo.errors : [];
	return str(obj(reasons[0]).reason) ?? str(eo.code) ?? str(eo.status);
}
