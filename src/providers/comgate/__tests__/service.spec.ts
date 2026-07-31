import { BigNumber } from "@medusajs/framework/utils"
import ComgateProviderService from "../service"
import type { ComgateOptions } from "../types"

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any

function makeService(options: Partial<ComgateOptions> = {}) {
	return new ComgateProviderService({ logger }, {
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

	it("maps PAID -> captured and resolves session from refId", async () => {
		const svc = makeService()
		const res = await svc.getWebhookActionAndData({ data: { ...baseNote, status: "PAID" } } as any)
		expect(res.action).toBe("captured")
		expect(res.data?.session_id).toBe("ps_123")
		expect((res.data!.amount as BigNumber).numeric).toBe(10000)
	})

	it("maps AUTHORIZED -> authorized", async () => {
		const svc = makeService()
		const res = await svc.getWebhookActionAndData({ data: { ...baseNote, status: "AUTHORIZED" } } as any)
		expect(res.action).toBe("authorized")
	})

	it("maps CANCELLED -> failed", async () => {
		const svc = makeService()
		const res = await svc.getWebhookActionAndData({ data: { ...baseNote, status: "CANCELLED" } } as any)
		expect(res.action).toBe("failed")
	})

	it("rejects on secret mismatch", async () => {
		const svc = makeService()
		const res = await svc.getWebhookActionAndData({
			data: { ...baseNote, secret: "wrong", status: "PAID" },
		} as any)
		expect(res.action).toBe("failed")
		expect(res.data?.session_id).toBe("")
	})

	it("parses JSON rawData when body not pre-parsed", async () => {
		const svc = makeService()
		const raw = JSON.stringify({ ...baseNote, status: "PAID" })
		const res = await svc.getWebhookActionAndData({ data: {}, rawData: raw } as any)
		expect(res.action).toBe("captured")
		expect(res.data?.session_id).toBe("ps_123")
	})

	it("returns not_supported when transId/refId/status missing", async () => {
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
		const res = await svc.retrievePayment({ data: { transId: "T" } } as any)
		expect((res.data as any).status).toBe("PAID")
		expect((res.data as any).price).toBe("10000")
	})

	it("updatePayment is a no-op that echoes data (Comgate cannot change amount)", async () => {
		const svc = makeService()
		const res = await svc.updatePayment({ data: { transId: "T", foo: 1 } } as any)
		expect(res.data).toEqual({ transId: "T", foo: 1 })
	})
})
