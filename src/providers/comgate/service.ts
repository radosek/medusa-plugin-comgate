import { AbstractPaymentProvider, BigNumber, MedusaError, PaymentActions } from "@medusajs/framework/utils"
import type {
	AuthorizePaymentInput,
	AuthorizePaymentOutput,
	CancelPaymentInput,
	CancelPaymentOutput,
	CapturePaymentInput,
	CapturePaymentOutput,
	DeletePaymentInput,
	DeletePaymentOutput,
	GetPaymentStatusInput,
	GetPaymentStatusOutput,
	InitiatePaymentInput,
	InitiatePaymentOutput,
	Logger,
	ProviderWebhookPayload,
	RefundPaymentInput,
	RefundPaymentOutput,
	RetrievePaymentInput,
	RetrievePaymentOutput,
	UpdatePaymentInput,
	UpdatePaymentOutput,
	WebhookActionResult,
} from "@medusajs/framework/types"
import { ComgateClient, ComgateUnreachableError } from "./lib/client"
import type { ComgateNotification, ComgateOptions, ComgatePaymentData, ComgateStatus } from "./types"

type StoredSession = {
	id: string
	amount: unknown
	currency_code: string
	data?: Record<string, unknown> | null
}

/** Payment-module-internal session service; the provider is resolved from that module's container. */
type PaymentSessionReader = {
	retrieve(id: string, config?: { select?: string[] }): Promise<StoredSession>
}

type InjectedDependencies = {
	logger: Logger
	paymentSessionService?: PaymentSessionReader
}

type CanonicalStatus = { status?: ComgateStatus; price?: string; curr?: string; refId?: string }

class ComgateProviderService extends AbstractPaymentProvider<ComgateOptions> {
	static identifier = "comgate"

	protected readonly options_: ComgateOptions
	protected readonly client_: ComgateClient
	protected readonly logger_: Logger
	protected readonly container_: InjectedDependencies

	static validateOptions(options: ComgateOptions): void {
		if (!options.merchant) {
			throw new MedusaError(
				MedusaError.Types.INVALID_DATA,
				"Comgate provider requires the `merchant` option.",
			)
		}
		if (!options.secret) {
			throw new MedusaError(MedusaError.Types.INVALID_DATA, "Comgate provider requires the `secret` option.")
		}
	}

	constructor(container: InjectedDependencies, options: ComgateOptions) {
		super(container, options)
		this.options_ = options
		this.logger_ = container.logger
		this.container_ = container
		this.client_ = new ComgateClient(options)
	}

	private get test(): boolean {
		return this.options_.test ?? true
	}

	private data(data?: Record<string, unknown>): ComgatePaymentData {
		return (data ?? {}) as ComgatePaymentData
	}

	/**
	 * Map a Comgate status to a Medusa payment session status. In `preauth` mode
	 * `PAID` means the gateway already captured (one-step), `AUTHORIZED` means the
	 * amount is reserved and awaiting capture.
	 */
	private mapStatus(status: ComgateStatus | undefined): GetPaymentStatusOutput["status"] {
		switch (status) {
			case "PAID":
				return "captured"
			case "AUTHORIZED":
				return "authorized"
			case "CANCELLED":
				return "canceled"
			case "PENDING":
			default:
				return "pending"
		}
	}

	async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
		const { amount, currency_code, context } = input

		const email =
			(context?.customer?.email as string) ?? (input.data?.email as string) ?? "noreply@example.com"
		const label = (this.options_.label ?? "Order").slice(0, 16)

		// The webhook resolves the Medusa payment session by `refId`, so it has to be
		// unique per session. The Payment Module always injects `session_id`; the
		// idempotency key is a per-session fallback. Never fall back to `label` — that
		// is static config, so every payment would share one refId and none of them
		// could be reconciled.
		const refId = (input.data?.session_id as string) ?? (context?.idempotency_key as string)
		if (!refId) {
			throw new MedusaError(
				MedusaError.Types.INVALID_DATA,
				"Comgate cannot create a payment without a session id: the payment could not be matched to its webhook.",
			)
		}

		const res = await this.client_.create({
			price: this.toMinorUnits(amount, currency_code),
			curr: currency_code.toUpperCase(),
			label,
			refId,
			method: this.options_.method ?? "ALL",
			email,
			test: this.test,
			preauth: this.options_.preauth || undefined,
			country: this.options_.country,
			lang: this.options_.lang,
			fullName: context?.customer
				? [context.customer.first_name, context.customer.last_name].filter(Boolean).join(" ") || undefined
				: undefined,
			url_paid: this.options_.url_paid,
			url_cancelled: this.options_.url_cancelled,
			url_pending: this.options_.url_pending,
		})

		const data: ComgatePaymentData = {
			transId: res.transId!,
			redirect: res.redirect,
			status: "PENDING",
			price: this.toMinorUnits(amount, currency_code),
			curr: currency_code.toUpperCase(),
			refId,
			preauth: !!this.options_.preauth,
			test: this.test,
		}

		return { id: res.transId!, data, status: "pending" }
	}

	async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
		const { transId } = this.data(input.data)
		const res = await this.client_.status(transId)
		return { status: this.mapStatus(res.status), data: { ...input.data, status: res.status } }
	}

	async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
		const { transId } = this.data(input.data)
		const res = await this.client_.status(transId)
		return { status: this.mapStatus(res.status), data: { ...input.data, status: res.status } }
	}

	async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
		const data = this.data(input.data)
		// Direct-capture payments are already captured on the gateway (PAID).
		if (!data.preauth) {
			return { data: input.data ?? {} }
		}
		await this.client_.capturePreauth(data.transId)
		return { data: { ...input.data, status: "PAID" satisfies ComgateStatus } }
	}

	async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
		const data = this.data(input.data)
		const amount = this.toMinorUnits(input.amount, data.curr ?? "CZK")
		// Comgate rejects a refund whose `test` differs from the payment's (1402), so
		// use the flag the payment was created with, not the current config.
		await this.client_.refund(data.transId, amount, data.test ?? this.test, data.refId)
		return { data: input.data ?? {} }
	}

	async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
		const data = this.data(input.data)
		try {
			if (data.preauth) {
				await this.client_.cancelPreauth(data.transId)
			} else {
				await this.client_.cancel(data.transId)
			}
		} catch (e) {
			// A payment that was never paid / already terminal cannot be cancelled;
			// treat as a no-op so the Medusa flow can proceed.
			this.logger_.warn(`Comgate cancelPayment ignored: ${this.client_.redact((e as Error).message)}`)
		}
		return { data: { ...input.data, status: "CANCELLED" satisfies ComgateStatus } }
	}

	async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
		return this.cancelPayment(input)
	}

	async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
		const { transId } = this.data(input.data)
		const res = await this.client_.status(transId)
		return { data: { ...input.data, ...res } }
	}

	async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
		// Comgate has no amount-update endpoint; the payment is fixed once created.
		return { data: input.data ?? {} }
	}

	async getWebhookActionAndData(payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
		const noop: WebhookActionResult = {
			action: PaymentActions.NOT_SUPPORTED,
			data: { session_id: "", amount: new BigNumber(0) },
		}

		const note = this.parseNotification(payload)
		if (!note) {
			return noop
		}

		// v2.0 PUSH may omit `secret`; a present one must match. Compared in
		// constant time to avoid leaking the secret via timing.
		const secretVerified = note.secret !== undefined && this.client_.verifySecret(note.secret)
		if (note.secret !== undefined && !secretVerified) {
			this.logger_.error(`Comgate webhook rejected: secret mismatch (transId ${note.transId})`)
			return noop
		}

		// The status API is the source of truth, not the PUSH body. When it cannot be
		// reached the body is trusted only if its secret verified — an unauthenticated
		// body must never move a payment.
		let canonical: CanonicalStatus
		try {
			canonical = await this.client_.status(note.transId)
		} catch (e) {
			const message = this.client_.redact((e as Error).message)
			if (e instanceof ComgateUnreachableError && secretVerified && note.status && note.price && note.curr) {
				this.logger_.warn(`Comgate status API unreachable, using secret-verified PUSH body: ${message}`)
				canonical = note
			} else {
				this.logger_.warn(`Comgate webhook for ${note.transId} ignored, status unavailable: ${message}`)
				return noop
			}
		}

		// refId is the Medusa payment session id (set at initiate).
		const refId = note.refId
		if (!refId || canonical.refId !== refId) {
			this.logger_.error(
				`Comgate webhook rejected: refId ${String(refId)} does not match Comgate's ${String(canonical.refId)} (transId ${note.transId})`,
			)
			return noop
		}

		let session: StoredSession
		try {
			session = await this.sessionService().retrieve(refId, {
				select: ["id", "amount", "currency_code", "data"],
			})
		} catch (e) {
			this.logger_.warn(`Comgate webhook for unknown session ${refId} ignored: ${(e as Error).message}`)
			return noop
		}

		const storedTransId = session.data?.transId
		if (storedTransId && storedTransId !== note.transId) {
			this.logger_.error(
				`Comgate webhook rejected: transId ${note.transId} is not the one stored on session ${refId}`,
			)
			return noop
		}

		const price = Number(canonical.price)
		const expected = this.toMinorUnits(
			session.amount as InitiatePaymentInput["amount"],
			session.currency_code,
		)
		const currency = session.currency_code.toUpperCase()
		if (!Number.isInteger(price) || price !== expected || canonical.curr !== currency) {
			this.logger_.error(
				`Comgate webhook rejected: ${String(canonical.price)} ${String(canonical.curr)} does not match session ${refId} (${expected} ${currency})`,
			)
			return noop
		}

		// Comgate reports minor units; Medusa's capture uses `amount` as a decimal.
		const data = { session_id: refId, amount: new BigNumber(price / 100) }

		switch (canonical.status) {
			case "PAID":
				return { action: PaymentActions.SUCCESSFUL, data }
			case "AUTHORIZED":
				return { action: PaymentActions.AUTHORIZED, data }
			case "CANCELLED":
				// Medusa ignores FAILED webhook actions, so a late CANCELLED after PAID
				// cannot undo a captured payment.
				return { action: PaymentActions.FAILED, data }
			case "PENDING":
				return { action: PaymentActions.PENDING, data }
			default:
				return noop
		}
	}

	private sessionService(): PaymentSessionReader {
		const service = this.container_.paymentSessionService
		if (!service) {
			throw new Error("paymentSessionService is not available in the payment module container")
		}
		return service
	}

	private parseNotification(payload: ProviderWebhookPayload["payload"]): ComgateNotification | undefined {
		const { data, rawData } = payload
		let parsed: Record<string, unknown> | undefined = data as Record<string, unknown>

		// REST v2.0 PUSH is JSON, older merchants still get form-encoded bodies.
		// Depending on the body parser the framework hands us either the parsed
		// object or the raw buffer.
		if (!parsed?.transId && rawData) {
			const raw = rawData.toString()
			try {
				parsed = JSON.parse(raw)
			} catch {
				const form = new URLSearchParams(raw)
				parsed = form.get("transId") ? Object.fromEntries(form) : undefined
			}
		}

		if (typeof parsed?.transId !== "string" || !parsed.transId) {
			this.logger_.warn("Comgate webhook missing transId")
			return undefined
		}
		return parsed as ComgateNotification
	}

	/**
	 * Convert a Medusa decimal amount (e.g. 12.50) into Comgate minor units
	 * (1250). Comgate uses the smallest currency unit for every currency.
	 */
	private toMinorUnits(amount: InitiatePaymentInput["amount"], _currency: string): number {
		// `BigNumberInput` is a union: number, string, BigNumber, BigNumberJS, or a
		// raw `{ value, precision }` object — the Payment Module passes
		// `refund.raw_amount` (the raw form) straight into `refundPayment`. Medusa's
		// own BigNumber normalises every member of that union, so let it do the work
		// rather than picking properties off the input by hand.
		let value: number
		try {
			value = new BigNumber(amount).numeric
		} catch {
			value = Number.NaN
		}

		if (!Number.isFinite(value)) {
			throw new MedusaError(
				MedusaError.Types.INVALID_DATA,
				`Comgate received a non-numeric amount: ${JSON.stringify(amount)}`,
			)
		}
		return Math.round(value * 100)
	}
}

export default ComgateProviderService
