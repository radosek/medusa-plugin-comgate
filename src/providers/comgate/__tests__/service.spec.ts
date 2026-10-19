import { BigNumber } from "@medusajs/framework/utils"
import { ComgateError, ComgateUnreachableError } from "../lib/client"
import ComgateProviderService from "../service"
import type { ComgateOptions } from "../types"

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any

const session = {
	id: "ps_123",
	amount: 100,
	currency_code: "czk",
	data: { transId: "AB12-CD34" } as Record<string, unknown>,
}
const paymentSessionService = { retrieve: jest.fn() }

beforeEach(() => {
	jest.clearAllMocks()
	paymentSessionService.retrieve.mockResolvedValue(session)
})

function makeService(options: Partial<ComgateOptions> = {}) {
	return new ComgateProviderService({ logger, paymentSessionService }, {
		merchant: "123456",
		secret: "topsecret",
		test: true,
		...options,
	} as ComgateOptions)
}

describe("ComgateProviderService.validateOptions", () => {
	it("throws without merchant", () => {
		expect(() => ComgateProviderService.validateOptions({ secret: "x" } as ComgateOptions)).toThrow()
	})
	it("throws without secret", () => {
		expect(() => ComgateProviderService.validateOptions({ merchant: "x" } as ComgateOptions)).toThrow()
	})
	it("passes with both", () => {
		expect(() =>
			ComgateProviderService.validateOptions({ merchant: "x", secret: "y" } as ComgateOptions),
		).not.toThrow()
	})
})

const canonical = (over: Record<string, unknown> = {}) => ({
	code: 0,
	message: "OK",
	transId: "AB12-CD34",
	refId: "ps_123",
	price: "10000",
	curr: "CZK",
	status: "PAID",
	...over,
})

function withStatus(svc: ComgateProviderService, impl: () => Promise<unknown>) {
	return jest.spyOn((svc as any).client_, "status").mockImplementation(impl)
}

describe("getWebhookActionAndData", () => {
	const baseNote = {
		transId: "AB12-CD34",
		refId: "ps_123",
		price: "10000",
		curr: "CZK",
		merchant: "123456",
		secret: "topsecret",
		test: "true",
	}
	it("takes the status from the status API, not the PUSH body", async () => {
		const svc = makeService()
		const status = withStatus(svc, async () => canonical({ status: "CANCELLED" }))
		const res = await svc.getWebhookActionAndData({ data: { ...baseNote, status: "PAID" } } as any)
		expect(status).toHaveBeenCalledWith("AB12-CD34")
		expect(res.action).toBe("failed")
	})

	it("maps canonical PAID -> captured with the amount in major units", async () => {
		const svc = makeService()
		withStatus(svc, async () => canonical())
		const res = await svc.getWebhookActionAndData({ data: { ...baseNote, status: "PAID" } } as any)
		expect(res.action).toBe("captured")
		expect(res.data?.session_id).toBe("ps_123")
		expect((res.data!.amount as BigNumber).numeric).toBe(100)
	})

	it("maps AUTHORIZED -> authorized and PENDING -> pending", async () => {
		const svc = makeService()
		withStatus(svc, async () => canonical({ status: "AUTHORIZED" }))
		expect((await svc.getWebhookActionAndData({ data: baseNote } as any)).action).toBe("authorized")
		withStatus(svc, async () => canonical({ status: "PENDING" }))
		expect((await svc.getWebhookActionAndData({ data: baseNote } as any)).action).toBe("pending")
	})

	it("answers a late CANCELLED with FAILED, which Medusa does not act on", async () => {
		const svc = makeService()
		withStatus(svc, async () => canonical({ status: "CANCELLED" }))
		const res = await svc.getWebhookActionAndData({ data: { ...baseNote, status: "CANCELLED" } } as any)
		expect(res.action).toBe("failed")
		expect(res.action).not.toBe("captured")
	})

	it("is a no-op for an unknown canonical status", async () => {
		const svc = makeService()
		withStatus(svc, async () => canonical({ status: "WEIRD" }))
		expect((await svc.getWebhookActionAndData({ data: baseNote } as any)).action).toBe("not_supported")
	})

	it("falls back to a secret-verified PUSH body when the status API is unreachable", async () => {
		const svc = makeService()
		withStatus(svc, async () => {
			throw new ComgateUnreachableError("socket closed")
		})
		const res = await svc.getWebhookActionAndData({ data: { ...baseNote, status: "PAID" } } as any)
		expect(res.action).toBe("captured")
		expect((res.data!.amount as BigNumber).numeric).toBe(100)
	})

	it("does not fall back when the PUSH body carries no secret", async () => {
		const svc = makeService()
		withStatus(svc, async () => {
			throw new ComgateUnreachableError("socket closed")
		})
		const { secret: _secret, ...unsigned } = baseNote
		const res = await svc.getWebhookActionAndData({ data: { ...unsigned, status: "PAID" } } as any)
		expect(res.action).toBe("not_supported")
		expect(res.data?.session_id).toBe("")
	})

	it("does not fall back when Comgate answered with an error code", async () => {
		const svc = makeService()
		withStatus(svc, async () => {
			throw new ComgateError("status", 1400, "bad request")
		})
		const res = await svc.getWebhookActionAndData({ data: { ...baseNote, status: "PAID" } } as any)
		expect(res.action).toBe("not_supported")
	})

	it("trusts an unsigned PUSH when the status API confirms it", async () => {
		const svc = makeService()
		withStatus(svc, async () => canonical())
		const { secret: _secret, ...unsigned } = baseNote
		const res = await svc.getWebhookActionAndData({ data: { ...unsigned, status: "PAID" } } as any)
		expect(res.action).toBe("captured")
	})

	it("rejects a wrong secret without calling Comgate", async () => {
		const svc = makeService()
		const status = withStatus(svc, async () => canonical())
		const res = await svc.getWebhookActionAndData({
			data: { ...baseNote, secret: "wrong", status: "PAID" },
		} as any)
		expect(res.action).toBe("not_supported")
		expect(res.data?.session_id).toBe("")
		expect(status).not.toHaveBeenCalled()
	})

	it("rejects when the canonical price does not match the session amount", async () => {
		const svc = makeService()
		withStatus(svc, async () => canonical({ price: "100" }))
		const res = await svc.getWebhookActionAndData({ data: baseNote } as any)
		expect(res.action).toBe("not_supported")
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("does not match session"))
	})

	it("rejects when the canonical currency does not match the session", async () => {
		const svc = makeService()
		withStatus(svc, async () => canonical({ curr: "EUR" }))
		expect((await svc.getWebhookActionAndData({ data: baseNote } as any)).action).toBe("not_supported")
	})

	it("rejects a tampered PUSH body on the fallback path too", async () => {
		const svc = makeService()
		withStatus(svc, async () => {
			throw new ComgateUnreachableError("down")
		})
		const res = await svc.getWebhookActionAndData({
			data: { ...baseNote, price: "1", status: "PAID" },
		} as any)
		expect(res.action).toBe("not_supported")
	})

	it("rejects when Comgate's refId differs from the PUSH refId", async () => {
		const svc = makeService()
		withStatus(svc, async () => canonical({ refId: "ps_other" }))
		expect((await svc.getWebhookActionAndData({ data: baseNote } as any)).action).toBe("not_supported")
		expect(paymentSessionService.retrieve).not.toHaveBeenCalled()
	})

	it("rejects a transId that is not the one stored on the session", async () => {
		const svc = makeService()
		paymentSessionService.retrieve.mockResolvedValue({ ...session, data: { transId: "OTHER-1" } })
		withStatus(svc, async () => canonical())
		expect((await svc.getWebhookActionAndData({ data: baseNote } as any)).action).toBe("not_supported")
	})

	it("accepts a session with no stored transId yet", async () => {
		const svc = makeService()
		paymentSessionService.retrieve.mockResolvedValue({ ...session, data: {} })
		withStatus(svc, async () => canonical())
		expect((await svc.getWebhookActionAndData({ data: baseNote } as any)).action).toBe("captured")
	})

	it("acks an unknown session as a no-op", async () => {
		const svc = makeService()
		paymentSessionService.retrieve.mockRejectedValue(new Error("not found"))
		withStatus(svc, async () => canonical())
		expect((await svc.getWebhookActionAndData({ data: baseNote } as any)).action).toBe("not_supported")
	})

	it("parses JSON rawData when body not pre-parsed", async () => {
		const svc = makeService()
		withStatus(svc, async () => canonical())
		const raw = JSON.stringify({ ...baseNote, status: "PAID" })
		const res = await svc.getWebhookActionAndData({ data: {}, rawData: raw } as any)
		expect(res.action).toBe("captured")
	})

	it("parses a form-encoded rawData body", async () => {
		const svc = makeService()
		withStatus(svc, async () => canonical())
		const raw = new URLSearchParams({ ...baseNote, status: "PAID" }).toString()
		const res = await svc.getWebhookActionAndData({ data: {}, rawData: Buffer.from(raw) } as any)
		expect(res.action).toBe("captured")
	})

	it("returns not_supported when transId is missing", async () => {
		const svc = makeService()
		const res = await svc.getWebhookActionAndData({ data: {} } as any)
		expect(res.action).toBe("not_supported")
	})
})

describe("capturePayment", () => {
	it("is a no-op for direct-capture payments", async () => {
		const svc = makeService({ preauth: false })
		const res = await svc.capturePayment({ data: { transId: "X", preauth: false } } as any)
		expect(res.data).toEqual({ transId: "X", preauth: false })
	})

	it("calls capturePreauth in preauth mode", async () => {
		const svc = makeService({ preauth: true })
		const spy = jest
			.spyOn((svc as any).client_, "capturePreauth")
			.mockResolvedValue({ code: 0, message: "OK" })
		const res = await svc.capturePayment({ data: { transId: "X", preauth: true } } as any)
		expect(spy).toHaveBeenCalledWith("X")
		expect((res.data as any).status).toBe("PAID")
	})
})

describe("initiatePayment", () => {
	it("creates a payment, stores refId=session_id and returns redirect", async () => {
		const svc = makeService({ label: "Shop" })
		const create = jest
			.spyOn((svc as any).client_, "create")
			.mockResolvedValue({ code: 0, message: "OK", transId: "T1", redirect: "https://pay1.x/init?id=T1" })

		const res = await svc.initiatePayment({
			amount: 100.5,
			currency_code: "czk",
			data: { session_id: "ps_42" },
			context: { customer: { email: "buyer@x.cz", first_name: "Jan", last_name: "Novak" } },
		} as any)

		// price -> minor units, currency uppercased, refId = session id
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				price: 10050,
				curr: "CZK",
				refId: "ps_42",
				email: "buyer@x.cz",
				fullName: "Jan Novak",
				label: "Shop",
				test: true,
			}),
		)
		expect(res.id).toBe("T1")
		expect(res.status).toBe("pending")
		expect((res.data as any).redirect).toBe("https://pay1.x/init?id=T1")
		expect((res.data as any).refId).toBe("ps_42")
		expect((res.data as any).test).toBe(true)
	})

	it("truncates label to 16 chars and falls back to a default email", async () => {
		const svc = makeService({ label: "ThisLabelIsWayTooLongForComgate" })
		const create = jest
			.spyOn((svc as any).client_, "create")
			.mockResolvedValue({ code: 0, message: "OK", transId: "T2", redirect: "r" })

		await svc.initiatePayment({ amount: 1, currency_code: "EUR", data: { session_id: "ps_1" } } as any)

		const arg = create.mock.calls[0][0] as any
		expect(arg.label.length).toBeLessThanOrEqual(16)
		expect(arg.email).toBe("noreply@example.com")
		expect(arg.price).toBe(100) // 1 EUR -> 100 cents
	})

	it("falls back to the idempotency key when session_id is absent", async () => {
		const svc = makeService()
		const create = jest
			.spyOn((svc as any).client_, "create")
			.mockResolvedValue({ code: 0, message: "OK", transId: "T5", redirect: "r" })
		await svc.initiatePayment({
			amount: 1,
			currency_code: "CZK",
			context: { idempotency_key: "idem_1" },
		} as any)
		expect((create.mock.calls[0][0] as any).refId).toBe("idem_1")
	})

	it("refuses to create a payment with no session id rather than reusing the label", async () => {
		// A static label as refId would be shared by every payment, so none of them
		// could be matched to their webhook.
		const svc = makeService({ label: "Shop" })
		const create = jest.spyOn((svc as any).client_, "create")
		await expect(svc.initiatePayment({ amount: 1, currency_code: "CZK" } as any)).rejects.toThrow(
			/without a session id/,
		)
		expect(create).not.toHaveBeenCalled()
	})

	it("sends preauth flag when the provider is in preauth mode", async () => {
		const svc = makeService({ preauth: true })
		const create = jest
			.spyOn((svc as any).client_, "create")
			.mockResolvedValue({ code: 0, message: "OK", transId: "T3", redirect: "r" })
		await svc.initiatePayment({ amount: 1, currency_code: "CZK", data: { session_id: "s" } } as any)
		expect((create.mock.calls[0][0] as any).preauth).toBe(true)
		const svc2 = makeService({ preauth: false })
		const create2 = jest
			.spyOn((svc2 as any).client_, "create")
			.mockResolvedValue({ code: 0, message: "OK", transId: "T4", redirect: "r" })
		await svc2.initiatePayment({ amount: 1, currency_code: "CZK", data: { session_id: "s" } } as any)
		expect((create2.mock.calls[0][0] as any).preauth).toBeUndefined()
	})
})

describe("getPaymentStatus mapping", () => {
	const cases: Array<[string, string]> = [
		["PENDING", "pending"],
		["PAID", "captured"],
		["AUTHORIZED", "authorized"],
		["CANCELLED", "canceled"],
	]
	it.each(cases)("maps Comgate %s -> Medusa %s", async (comgate, medusa) => {
		const svc = makeService()
		jest.spyOn((svc as any).client_, "status").mockResolvedValue({ code: 0, message: "OK", status: comgate })
		const res = await svc.getPaymentStatus({ data: { transId: "T" } } as any)
		expect(res.status).toBe(medusa)
	})

	it("authorizePayment returns the mapped status and data", async () => {
		const svc = makeService()
		jest
			.spyOn((svc as any).client_, "status")
			.mockResolvedValue({ code: 0, message: "OK", status: "AUTHORIZED" })
		const res = await svc.authorizePayment({ data: { transId: "T" } } as any)
		expect(res.status).toBe("authorized")
		expect((res.data as any).transId).toBe("T")
	})
})

describe("refundPayment", () => {
	it("refunds in minor units with the stored refId", async () => {
		const svc = makeService()
		const refund = jest.spyOn((svc as any).client_, "refund").mockResolvedValue({ code: 0, message: "OK" })
		await svc.refundPayment({ amount: 25, data: { transId: "T", curr: "CZK", refId: "ps_9" } } as any)
		expect(refund).toHaveBeenCalledWith("T", 2500, true, "ps_9")
	})

	it("reuses the payment's own test flag, not the current config", async () => {
		const svc = makeService({ test: true })
		const refund = jest.spyOn((svc as any).client_, "refund").mockResolvedValue({ code: 0, message: "OK" })
		await svc.refundPayment({
			amount: 1,
			data: { transId: "T", curr: "CZK", refId: "r", test: false },
		} as any)
		expect(refund).toHaveBeenCalledWith("T", 100, false, "r")
	})

	it("refunds when Medusa passes a raw BigNumber amount ({ value, precision })", async () => {
		// The Payment Module hands `refund.raw_amount` straight to refundPayment;
		// it has no `.numeric`, so a naive Number(amount.numeric) yields NaN.
		const svc = makeService()
		const refund = jest.spyOn((svc as any).client_, "refund").mockResolvedValue({ code: 0, message: "OK" })
		await svc.refundPayment({
			amount: { value: "100.50000000000000000", precision: 20 },
			data: { transId: "T", curr: "CZK", refId: "ps_9" },
		} as any)
		expect(refund).toHaveBeenCalledWith("T", 10050, true, "ps_9")
	})

	it("refunds when the amount is a BigNumber instance", async () => {
		const svc = makeService()
		const refund = jest.spyOn((svc as any).client_, "refund").mockResolvedValue({ code: 0, message: "OK" })
		await svc.refundPayment({
			amount: new BigNumber(100.5),
			data: { transId: "T", curr: "CZK", refId: "ps_9" },
		} as any)
		expect(refund).toHaveBeenCalledWith("T", 10050, true, "ps_9")
	})

	it("refunds when the amount is a raw BigNumberJS instance", async () => {
		// `BigNumberInput` also admits a bignumber.js instance, which has neither
		// `.numeric` nor `.value` — reached here via BigNumber's own `bigNumber`
		// property so the test needs no direct bignumber.js dependency.
		const svc = makeService()
		const bigNumberJs = new BigNumber(100.5).bigNumber
		expect((bigNumberJs as any).numeric).toBeUndefined()

		const refund = jest.spyOn((svc as any).client_, "refund").mockResolvedValue({ code: 0, message: "OK" })
		await svc.refundPayment({
			amount: bigNumberJs,
			data: { transId: "T", curr: "CZK", refId: "ps_9" },
		} as any)
		expect(refund).toHaveBeenCalledWith("T", 10050, true, "ps_9")
	})

	it("refunds when the amount is a numeric string", async () => {
		const svc = makeService()
		const refund = jest.spyOn((svc as any).client_, "refund").mockResolvedValue({ code: 0, message: "OK" })
		await svc.refundPayment({ amount: "25.5", data: { transId: "T", curr: "CZK" } } as any)
		expect(refund).toHaveBeenCalledWith("T", 2550, true, undefined)
	})

	it("throws instead of sending NaN for an unusable amount", async () => {
		const svc = makeService()
		const refund = jest.spyOn((svc as any).client_, "refund").mockResolvedValue({ code: 0, message: "OK" })
		await expect(
			svc.refundPayment({ amount: {}, data: { transId: "T", curr: "CZK" } } as any),
		).rejects.toThrow(/non-numeric amount/)
		expect(refund).not.toHaveBeenCalled()
	})

	it("propagates a Comgate refund error", async () => {
		const svc = makeService()
		jest.spyOn((svc as any).client_, "refund").mockRejectedValue(new Error("1402 amount too high"))
		await expect(
			svc.refundPayment({ amount: 1, data: { transId: "T", curr: "CZK" } } as any),
		).rejects.toThrow("1402")
	})
})

describe("cancelPayment / deletePayment", () => {
	it("calls cancel (storno) for direct payments", async () => {
		const svc = makeService()
		const cancel = jest.spyOn((svc as any).client_, "cancel").mockResolvedValue({ code: 0, message: "OK" })
		const res = await svc.cancelPayment({ data: { transId: "T", preauth: false } } as any)
		expect(cancel).toHaveBeenCalledWith("T")
		expect((res.data as any).status).toBe("CANCELLED")
	})

	it("calls cancelPreauth for preauth payments", async () => {
		const svc = makeService()
		const cancelPreauth = jest
			.spyOn((svc as any).client_, "cancelPreauth")
			.mockResolvedValue({ code: 0, message: "OK" })
		await svc.cancelPayment({ data: { transId: "T", preauth: true } } as any)
		expect(cancelPreauth).toHaveBeenCalledWith("T")
	})

	it("swallows a cancel error (already-terminal payment) and still returns CANCELLED", async () => {
		const svc = makeService()
		jest.spyOn((svc as any).client_, "cancel").mockRejectedValue(new Error("1400 not pending"))
		const res = await svc.cancelPayment({ data: { transId: "T" } } as any)
		expect((res.data as any).status).toBe("CANCELLED")
		expect(logger.warn).toHaveBeenCalled()
	})

	it("deletePayment delegates to cancel", async () => {
		const svc = makeService()
		const cancel = jest.spyOn((svc as any).client_, "cancel").mockResolvedValue({ code: 0, message: "OK" })
		await svc.deletePayment({ data: { transId: "T" } } as any)
		expect(cancel).toHaveBeenCalledWith("T")
	})
})

describe("retrievePayment / updatePayment", () => {
	it("retrievePayment merges the live status into data", async () => {
		const svc = makeService()
		jest
			.spyOn((svc as any).client_, "status")
			.mockResolvedValue({ code: 0, message: "OK", status: "PAID", price: "10000" })
		const res = await svc.retrievePayment({ data: { transId: "T", price: 10000 } } as any)
		expect((res.data as any).status).toBe("PAID")
		expect((res.data as any).price).toBe(10000)
	})

	it("updatePayment keeps the payment when amount and currency do not change", async () => {
		const svc = makeService()
		const create = jest.spyOn((svc as any).client_, "create")
		const data = { transId: "T1", price: 10000, curr: "CZK", refId: "ps_1" }
		const res = await svc.updatePayment({ data, amount: 100, currency_code: "czk" } as any)
		expect(res.data).toEqual(data)
		expect(create).not.toHaveBeenCalled()
	})

	it("updatePayment replaces the payment when the amount changes", async () => {
		const svc = makeService()
		const cancel = jest.spyOn((svc as any).client_, "cancel").mockResolvedValue({ code: 0, message: "OK" })
		const create = jest
			.spyOn((svc as any).client_, "create")
			.mockResolvedValue({ code: 0, message: "OK", transId: "T2", redirect: "https://pay/T2" })
		const data = { transId: "T1", price: 10000, curr: "CZK", refId: "ps_1", redirect: "https://pay/T1" }
		const res = await svc.updatePayment({ data, amount: 120, currency_code: "czk" } as any)
		expect(cancel).toHaveBeenCalledWith("T1")
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ price: 12000, curr: "CZK", refId: "ps_1" }))
		expect(res.data).toMatchObject({ transId: "T2", redirect: "https://pay/T2", price: 12000, refId: "ps_1" })
	})

	it("updatePayment replaces the payment when the currency changes, even if the old one cannot be cancelled", async () => {
		const svc = makeService()
		jest.spyOn((svc as any).client_, "cancel").mockRejectedValue(new Error("already terminal"))
		jest
			.spyOn((svc as any).client_, "create")
			.mockResolvedValue({ code: 0, message: "OK", transId: "T3", redirect: "x" })
		const data = { transId: "T1", price: 10000, curr: "CZK", refId: "ps_1" }
		const res = await svc.updatePayment({ data, amount: 100, currency_code: "eur" } as any)
		expect(res.data).toMatchObject({ transId: "T3", curr: "EUR" })
	})
})
