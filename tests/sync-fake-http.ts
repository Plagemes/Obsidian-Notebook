// A scripted fake of the connector's `Http` and `Clock` (#126): no network, no timers.
import type { Http, HttpRequest, HttpResponse } from "../src/sync/auth/http";
import { abortError, type Clock } from "../src/sync/auth/retry";

export function res(status: number, body?: unknown, headers: Record<string, string> = {}): HttpResponse {
	const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
	const bytes = body instanceof ArrayBuffer ? body : new TextEncoder().encode(text).buffer;
	return { status, headers, text: body instanceof ArrayBuffer ? "" : text, arrayBuffer: bytes };
}

type Reply = HttpResponse | Error | ((req: HttpRequest) => HttpResponse | Error);

interface Route {
	method: string;
	match: string | RegExp | ((req: HttpRequest) => boolean);
	reply: Reply;
	left: number;
}

export class FakeHttp implements Http {
	readonly calls: HttpRequest[] = [];
	private readonly routes: Route[] = [];

	/** Answers requests matching `method` and `match` (URL prefix, regex, or predicate), `times` times (default: always). */
	on(method: string, match: Route["match"], reply: Reply, times = Infinity): this {
		this.routes.push({ method, match, reply, left: times });
		return this;
	}

	/** Same as `on`, once. Routes are tried in the order they were added; a used-up route is skipped. */
	once(method: string, match: Route["match"], reply: Reply): this {
		return this.on(method, match, reply, 1);
	}

	request(req: HttpRequest): Promise<HttpResponse> {
		this.calls.push(req);
		const route = this.routes.find((r) => r.left > 0 && r.method === req.method && (typeof r.match === "string" ? req.url.startsWith(r.match) : r.match instanceof RegExp ? r.match.test(req.url) : r.match(req)));
		if (!route) return Promise.reject(new Error(`unexpected request ${req.method} ${req.url}`));
		route.left--;
		const out = typeof route.reply === "function" ? route.reply(req) : route.reply;
		return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
	}

	/** The calls with this method whose URL starts with (or matches) `match`. */
	find(method: string, match: string | RegExp): HttpRequest[] {
		return this.calls.filter((c) => c.method === method && (typeof match === "string" ? c.url.startsWith(match) : match.test(c.url)));
	}
}

export class FakeClock implements Clock {
	readonly slept: number[] = [];
	constructor(public t = 1_700_000_000_000) {}
	now(): number {
		return this.t;
	}
	sleep(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(abortError());
		this.slept.push(ms);
		this.t += ms;
		return Promise.resolve();
	}
}

/** The form fields of a request body. */
export function form(req: HttpRequest): Record<string, string> {
	return Object.fromEntries(new URLSearchParams(typeof req.body === "string" ? req.body : ""));
}

export function bodyJson(req: HttpRequest): Record<string, unknown> {
	return JSON.parse(typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body)) as Record<string, unknown>;
}

export function bytes(n: number, fill = 7): ArrayBuffer {
	return new Uint8Array(n).fill(fill).buffer;
}
