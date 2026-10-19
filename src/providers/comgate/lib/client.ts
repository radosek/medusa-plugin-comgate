import { timingSafeEqual } from "node:crypto"
import type {
	CodeMessageResponse,
	ComgateOptions,
	CreatePaymentRequest,
	CreatePaymentResponse,
	StatusResponse,
} from "../types"

const DEFAULT_BASE_URL = "https://payments.comgate.cz"
const MAX_ATTEMPTS = 4
const ATTEMPT_TIMEOUT_MS = 15_000
// Errors raised before any byte of the request reached the server.
const CONNECT_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"])

/**
 * `any` retries every thrown network error. `connect` retries only errors proving
 * the request was never sent — for calls where a repeat would move money twice.
 */
type RetryMode = "any" | "connect"

function isConnectError(e: unknown): boolean {
	const code = (e as { cause?: { code?: string } })?.cause?.code
	return code !== undefined && CONNECT_ERROR_CODES.has(code)
}

export class ComgateError extends Error {
	code: number
	constructor(action: string, code: number, message: string) {
		super(`Comgate ${action} failed (code ${code}): ${message}`)
		this.name = "ComgateError"
		this.code = code
	}
}

/**
 * The request never produced a Comgate answer: the socket failed on every attempt,
 * or a relay in front of Comgate answered with a non-Comgate error. Distinct from
 * `ComgateError`, which carries a code Comgate itself returned.
 */
export class ComgateUnreachableError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ComgateUnreachableError"
	}
}

type ClientOptions = Pick<ComgateOptions, "merchant" | "secret" | "base_url" | "proxy_key">

/**
 * Client for the Comgate REST v2.0 JSON API.
 * https://apidoc.comgate.cz/en/api/rest/
 *
 * Auth is HTTP Basic: `Authorization: Basic base64(merchant:secret)`.
 * Every call sends/receives `application/json`.
 */
export class ComgateClient {
	private readonly secret: string
	private readonly baseUrl: string
	private readonly authHeader: string
	private readonly proxyKey?: string
	private readonly sleep: (ms: number) => Promise<void>

	constructor(options: ClientOptions, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
		this.secret = options.secret
		this.baseUrl = (options.base_url ?? DEFAULT_BASE_URL).replace(/\/$/, "")
		this.authHeader = "Basic " + Buffer.from(`${options.merchant}:${options.secret}`).toString("base64")
		this.proxyKey = options.proxy_key
		this.sleep = sleep
	}

	/** Replace every credential this client knows with `[REDACTED]`. */
	redact(text: string): string {
		let out = text
		for (const s of [this.secret, this.authHeader.slice(6), this.proxyKey]) {
			if (s) out = out.split(s).join("[REDACTED]")
		}
		return out
	}

	/** POST /v2.0/payment.json — create a background payment, returns transId + redirect. */
	async create(req: CreatePaymentRequest): Promise<CreatePaymentResponse> {
		// Required by the legacy HTTP API (otherwise create 302-redirects to an error
		// page). v2.0 does not document it and behaves the same either way; sent to
		// match the integration proven in production.
		const body = await this.request("POST", "/v2.0/payment.json", { ...req, prepareOnly: true })
		this.assertOk("create", body)
		return body as unknown as CreatePaymentResponse
	}

	/** GET /v2.0/payment/transId/{transId}.json — fetch current payment state. */
	async status(transId: string): Promise<StatusResponse> {
		const body = await this.request("GET", `/v2.0/payment/transId/${encodeURIComponent(transId)}.json`)
		this.assertOk("status", body)
		return body as unknown as StatusResponse
	}

	/** DELETE /v2.0/payment/transId/{transId}.json — storno; only works while PENDING. */
	async cancel(transId: string): Promise<CodeMessageResponse> {
		const body = await this.request("DELETE", `/v2.0/payment/transId/${encodeURIComponent(transId)}.json`)
		this.assertOk("cancel", body)
		return body as unknown as CodeMessageResponse
	}

	/** POST /v2.0/refund.json — refund a PAID payment, full or partial. */
	async refund(transId: string, amount: number, test: boolean, refId?: string): Promise<CodeMessageResponse> {
		const body = await this.request("POST", "/v2.0/refund.json", { transId, amount, test, refId }, "connect")
		this.assertOk("refund", body)
		return body as unknown as CodeMessageResponse
	}

	/** PUT /v2.0/preauth/transId/{transId}.json — capture an AUTHORIZED pre-auth. */
	async capturePreauth(transId: string, amount?: number): Promise<CodeMessageResponse> {
		const body = await this.request(
			"PUT",
			`/v2.0/preauth/transId/${encodeURIComponent(transId)}.json`,
			amount != null ? { amount } : {},
			"connect",
		)
		this.assertOk("capturePreauth", body)
		return body as unknown as CodeMessageResponse
	}

	/** DELETE /v2.0/preauth/transId/{transId}.json — release an AUTHORIZED pre-auth. */
	async cancelPreauth(transId: string): Promise<CodeMessageResponse> {
		const body = await this.request("DELETE", `/v2.0/preauth/transId/${encodeURIComponent(transId)}.json`)
		this.assertOk("cancelPreauth", body)
		return body as unknown as CodeMessageResponse
	}

	/**
	 * Constant-time compare of a webhook-supplied `secret` against the configured
	 * one. Comgate authenticates PUSH notifications by echoing the secret.
	 */
	verifySecret(received: unknown): boolean {
		if (typeof received !== "string") return false
		const a = Buffer.from(received)
		const b = Buffer.from(this.secret)
		if (a.length !== b.length) return false
		return timingSafeEqual(a, b)
	}

	private async request(
		method: string,
		path: string,
		body?: Record<string, unknown>,
		retry: RetryMode = "any",
	): Promise<Record<string, unknown>> {
		const headers: Record<string, string> = { Authorization: this.authHeader }
		if (this.proxyKey) headers["X-Proxy-Key"] = this.proxyKey
		let payload: string | undefined
		if (body !== undefined) {
			headers["Content-Type"] = "application/json"
			payload = JSON.stringify(stripUndefined(body))
		}

		// The IPv4 relay auto-suspends when idle and drops the first socket while it
		// wakes, so thrown network errors are retried with backoff. Any HTTP response
		// (e.g. a 1400 for a non-whitelisted IP) is final and never retried.
		let response: Response | undefined
		let lastError = ""
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			// oxlint-disable-next-line no-await-in-loop -- retries are sequential by design
			if (attempt > 0) await this.sleep(1000 * attempt)
			try {
				// oxlint-disable-next-line no-await-in-loop
				response = await fetch(`${this.baseUrl}${path}`, {
					method,
					headers,
					body: payload,
					signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
				})
				break
			} catch (e) {
				lastError = String((e as Error)?.message ?? e)
				if (retry === "connect" && !isConnectError(e)) break
			}
		}
		if (!response) {
			throw new ComgateUnreachableError(this.redact(`Comgate ${path} unreachable: ${lastError}`))
		}

		let text: string
		try {
			text = await response.text()
		} catch (e) {
			throw new ComgateUnreachableError(
				this.redact(`Comgate ${path} response body failed: ${String((e as Error)?.message ?? e)}`),
			)
		}
		let parsed: Record<string, unknown>
		try {
			parsed = text ? JSON.parse(text) : {}
		} catch {
			throw new ComgateUnreachableError(
				this.redact(`Comgate ${path} returned non-JSON HTTP ${response.status}: ${text.slice(0, 200)}`),
			)
		}
		if (!response.ok && parsed.code === undefined) {
			throw new ComgateUnreachableError(
				this.redact(
					`Comgate ${path} failed with HTTP ${response.status}: ${parsed.message ? String(parsed.message) : "no Comgate code"}`,
				),
			)
		}
		return parsed
	}

	private assertOk(action: string, body: Record<string, unknown>): void {
		const code = Number(body.code)
		if (code !== 0) {
			throw new ComgateError(action, code, this.redact(String(body.message ?? "unknown error")))
		}
	}
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined && v !== null) out[k] = v
	}
	return out
}
