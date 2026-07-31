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
import { ComgateClient } from "./lib/client"
import type { ComgateNotification, ComgateOptions, ComgatePaymentData, ComgateStatus } from "./types"

type InjectedDependencies = {
	logger: Logger
}

class ComgateProviderService extends AbstractPaymentProvider<ComgateOptions> {
	static identifier = "comgate"

	protected readonly options_: ComgateOptions
	protected readonly client_: ComgateClient
	protected readonly logger_: Logger

	static validateOptions(options: ComgateOptions): void {
		if (!options.merchant) {
			throw new MedusaError(MedusaError.Types.INVALID_DATA, "Comgate provider requires the `merchant` option.")
		}
		if (!options.secret) {
			throw new MedusaError(MedusaError.Types.INVALID_DATA, "Comgate provider requires the `secret` option.")
		}
	}

	constructor(container: InjectedDependencies, options: ComgateOptions) {
		super(container, options)
		this.options_ = options
		this.logger_ = container.logger
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
			(context?.customer?.email as string) ??
			(input.data?.email as string) ??
			"noreply@example.com"
		const label = (this.options_.label ?? "Order").slice(0, 16)
		const refId = (input.data?.session_id as string) ?? (context?.idempotency_key as string) ?? label

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
		await this.client_.refund(data.transId, amount, this.test, data.refId)
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
			this.logger_.warn(`Comgate cancelPayment ignored: ${(e as Error).message}`)
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
		const note = this.parseNotification(payload)

		const noop: WebhookActionResult = {
			action: PaymentActions.NOT_SUPPORTED,
			data: { session_id: "", amount: new BigNumber(0) },
		}

		if (!note) {
			return noop
		}

		// The notification carries `secret` so we can verify it really came from
		// the merchant's Comgate account before acting on it. Compared in
		// constant time to avoid leaking the secret via timing.
		if (!this.client_.verifySecret(note.secret)) {
			this.logger_.error("Comgate webhook rejected: secret mismatch")
			return { ...noop, action: PaymentActions.FAILED }
		}

		const sessionId = note.refId // refId === Medusa payment session id (set at initiate)
		const amount = new BigNumber(Number(note.price) || 0)
		const data = { session_id: sessionId, amount }

		switch (note.status) {
			case "PAID":
				return { action: PaymentActions.SUCCESSFUL, data }
			case "AUTHORIZED":
				return { action: PaymentActions.AUTHORIZED, data }
			case "CANCELLED":
				return { action: PaymentActions.FAILED, data }
			case "PENDING":
			default:
				return { action: PaymentActions.PENDING, data }
		}
	}

	private parseNotification(payload: ProviderWebhookPayload["payload"]): ComgateNotification | undefined {
		const { data, rawData } = payload
		let parsed: Record<string, unknown> | undefined = data as Record<string, unknown>

		// REST v2.0 PUSH notifications are JSON. Depending on the body parser the
		// framework hands us either the parsed object or the raw buffer.
		if (!parsed?.transId && rawData) {
			try {
				parsed = JSON.parse(rawData.toString())
			} catch {
				this.logger_.warn("Comgate webhook rawData is not valid JSON")
				return undefined
			}
		}

		if (!parsed?.transId || !parsed?.refId || !parsed?.status) {
			this.logger_.warn("Comgate webhook missing transId/refId/status")
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
			throw new MedusaError(MedusaError.Types.INVALID_DATA, `Comgate received a non-numeric amount: ${JSON.stringify(amount)}`)
		}
		return Math.round(value * 100)
	}
}

export default ComgateProviderService
