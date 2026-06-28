/**
 * Options passed to the Comgate provider from `medusa-config.ts`.
 */
export interface ComgateOptions {
	/**
	 * [CS] identifikátor e-shopu v systému Comgate
	 * [EN] e-shop identifier in the Comgate system
	 */
	merchant: string
	/**
	 * [CS] heslo pro komunikaci na pozadí
	 * [EN] password for background (server-to-server) communication
	 */
	secret: string
	/**
	 * Test mode. When omitted defaults to `true`.
	 */
	test?: boolean
	/**
	 * Create payments as pre-authorizations (`preauth=true`). The amount is only
	 * reserved on the card and must be captured later via `capturePayment`.
	 * When omitted the payment is captured directly on the gateway.
	 */
	preauth?: boolean
	/**
	 * Default ISO 639-1 language for the payment gateway UI / customer e-mails.
	 * @default "cs"
	 */
	lang?: ComgateLang
	/**
	 * Default ISO 3166-1 country of the payer.
	 * @default "ALL"
	 */
	country?: string
	/**
	 * Static label shown on the gateway / bank statement (1–16 chars). When the
	 * cart does not provide one this is used. Falls back to `"Order"`.
	 */
	label?: string
	/**
	 * Payment method to offer. `"ALL"` lets the payer choose on the gateway.
	 * @default "ALL"
	 */
	method?: string
	/**
	 * Optional return URLs the payer is redirected to after paying, cancelling, or
	 * leaving the payment pending. Also configurable per-merchant in the portal; set
	 * them here to override per integration.
	 *
	 * When set via THIS API field, Comgate uses each URL **verbatim** — it does NOT
	 * append `transId`/`refId` params and does NOT substitute placeholders, so bake
	 * your own identifier in, e.g. `https://shop.com/checkout/return?refId=123`.
	 * (The portal return-URL fields DO substitute `${id}`/`${refId}`, case-sensitive
	 * — but those are configured in the Comgate portal, not here.) The return page
	 * looks the order up from the baked-in id. The redirect is not authoritative
	 * regardless — confirm payment via the webhook or by re-querying server-side.
	 */
	url_paid?: string
	url_cancelled?: string
	url_pending?: string
	/**
	 * Override the API base url. Defaults to the public Comgate endpoint.
	 */
	base_url?: string
}

export type ComgateLang =
	| "cs"
	| "sk"
	| "en"
	| "es"
	| "it"
	| "pl"
	| "fr"
	| "ro"
	| "de"
	| "hu"
	| "si"
	| "hr"
	| "no"
	| "sv"

/**
 * Status reported by the Comgate `status` endpoint and the background
 * notification. https://apidoc.comgate.cz/en/metody-platebni-brany/
 */
export type ComgateStatus = "PENDING" | "PAID" | "CANCELLED" | "AUTHORIZED"

/** Fields stored on the Medusa payment session `data`. */
export interface ComgatePaymentData extends Record<string, unknown> {
	transId: string
	redirect?: string
	status?: ComgateStatus
	price?: number
	curr?: string
	refId?: string
	preauth?: boolean
}

/**
 * Body for `POST /v2.0/payment.json`. Auth is the Basic header (no merchant /
 * secret in the body). v2.0 supports `prepareOnly`, but this provider omits it and
 * always does the background create that returns a `redirect` URL — that flow works
 * without it.
 */
export interface CreatePaymentRequest {
	/** Amount in the minor currency unit (e.g. cents / haléře). */
	price: number
	curr: string
	/** 1–16 chars. */
	label: string
	/** Merchant reference — we store the Medusa payment session id here. */
	refId: string
	method: string
	/** One of `email` / `phone` is required by Comgate. */
	email: string
	test: boolean
	preauth?: boolean
	country?: string
	lang?: ComgateLang
	fullName?: string
	phone?: string
	expirationTime?: string
	url_paid?: string
	url_cancelled?: string
	url_pending?: string
}

export interface CreatePaymentResponse {
	code: number
	message: string
	transId?: string
	redirect?: string
}

export interface StatusResponse {
	code: number
	message: string
	merchant?: string
	/** v2.0 returns these as strings. */
	test?: string
	price?: string
	curr?: string
	label?: string
	refId?: string
	method?: string
	email?: string
	status?: ComgateStatus
	fee?: string
	vs?: string
	paymentErrorReason?: string
}

export interface CodeMessageResponse {
	code: number
	message: string
}

/** Parameters Comgate POSTs to the merchant background-notification URL. */
export interface ComgateNotification extends Record<string, unknown> {
	transId: string
	refId: string
	status: ComgateStatus
	price: string
	curr: string
	merchant: string
	secret: string
	test: string
}
