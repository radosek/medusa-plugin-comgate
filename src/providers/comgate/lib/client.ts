import { timingSafeEqual } from "node:crypto"
import type {
	CodeMessageResponse,
	ComgateOptions,
	CreatePaymentRequest,
	CreatePaymentResponse,
	StatusResponse,
} from "../types"

const DEFAULT_BASE_URL = "https://payments.comgate.cz"

export class ComgateError extends Error {
	code: number
	constructor(action: string, code: number, message: string) {
		super(`Comgate ${action} failed (code ${code}): ${message}`)
		this.name = "ComgateError"
		this.code = code
	}
}

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

	constructor(options: Pick<ComgateOptions, "merchant" | "secret" | "base_url">) {
		this.secret = options.secret
		this.baseUrl = (options.base_url ?? DEFAULT_BASE_URL).replace(/\/$/, "")
		this.authHeader = "Basic " + Buffer.from(`${options.merchant}:${options.secret}`).toString("base64")
	}

	/** POST /v2.0/payment.json — create a background payment, returns transId + redirect. */
	async create(req: CreatePaymentRequest): Promise<CreatePaymentResponse> {
		const body = await this.request("POST", "/v2.0/payment.json", { ...req })
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
		const body = await this.request("POST", "/v2.0/refund.json", { transId, amount, test, refId })
		this.assertOk("refund", body)
		return body as unknown as CodeMessageResponse
	}

	/** PUT /v2.0/preauth/transId/{transId}.json — capture an AUTHORIZED pre-auth. */
	async capturePreauth(transId: string, amount?: number): Promise<CodeMessageResponse> {
		const body = await this.request(
			"PUT",
			`/v2.0/preauth/transId/${encodeURIComponent(transId)}.json`,
			amount != null ? { amount } : {},
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
	): Promise<Record<string, unknown>> {
		const headers: Record<string, string> = { Authorization: this.authHeader }
		let payload: string | undefined
		if (body !== undefined) {
			headers["Content-Type"] = "application/json"
			payload = JSON.stringify(stripUndefined(body))
		}

		const response = await fetch(`${this.baseUrl}${path}`, { method, headers, body: payload })

		const text = await response.text()
		let parsed: Record<string, unknown>
		try {
			parsed = text ? JSON.parse(text) : {}
		} catch {
			throw new ComgateError(path, response.status, `non-JSON response: ${text.slice(0, 200)}`)
		}
		if (!response.ok && parsed.code === undefined) {
			throw new ComgateError(path, response.status, parsed.message ? String(parsed.message) : "HTTP error")
		}
		return parsed
	}

	private assertOk(action: string, body: Record<string, unknown>): void {
		const code = Number(body.code)
		if (code !== 0) {
			throw new ComgateError(action, code, String(body.message ?? "unknown error"))
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
