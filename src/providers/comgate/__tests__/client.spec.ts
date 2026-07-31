import { ComgateClient, ComgateError } from "../lib/client"

const OPTS = { merchant: "123456", secret: "topsecret" }

function mockFetch(status: number, body: unknown) {
	return jest.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	})
}

describe("ComgateClient auth", () => {
	it("builds a Basic auth header from merchant:secret", async () => {
		const fetchMock = mockFetch(201, { code: 0, message: "OK", transId: "T1", redirect: "https://x" })
		;(global as any).fetch = fetchMock
		const client = new ComgateClient(OPTS)
		await client.create({
			price: 1000,
			curr: "CZK",
			label: "L",
			refId: "ps_1",
			method: "ALL",
			email: "a@b.cz",
			test: true,
		})
		const [url, init] = fetchMock.mock.calls[0]
		expect(url).toBe("https://payments.comgate.cz/v2.0/payment.json")
		expect(init.method).toBe("POST")
		expect(init.headers.Authorization).toBe("Basic " + Buffer.from("123456:topsecret").toString("base64"))
		expect(init.headers["Content-Type"]).toBe("application/json")
		expect(JSON.parse(init.body)).toMatchObject({ price: 1000, curr: "CZK", refId: "ps_1" })
	})

	it("strips undefined fields from the JSON body", async () => {
		const fetchMock = mockFetch(201, { code: 0, message: "OK", transId: "T", redirect: "x" })
		;(global as any).fetch = fetchMock
		const client = new ComgateClient(OPTS)
		await client.create({
			price: 1,
			curr: "CZK",
			label: "L",
			refId: "r",
			method: "ALL",
			email: "a@b.cz",
			test: true,
			preauth: undefined,
			country: undefined,
		})
		const body = JSON.parse(fetchMock.mock.calls[0][1].body)
		expect("preauth" in body).toBe(false)
		expect("country" in body).toBe(false)
	})

	it("throws ComgateError on non-zero code", async () => {
		;(global as any).fetch = mockFetch(200, { code: 1309, message: "wrong amount" })
		const client = new ComgateClient(OPTS)
		await expect(client.status("T1")).rejects.toBeInstanceOf(ComgateError)
	})
})

describe("status / cancel / preauth URLs", () => {
	it("GET status uses the transId path", async () => {
		const fetchMock = mockFetch(200, { code: 0, message: "OK", status: "PAID" })
		;(global as any).fetch = fetchMock
		await new ComgateClient(OPTS).status("AB12-CD34")
		expect(fetchMock.mock.calls[0][0]).toBe("https://payments.comgate.cz/v2.0/payment/transId/AB12-CD34.json")
		expect(fetchMock.mock.calls[0][1].method).toBe("GET")
	})

	it("DELETE cancel uses the transId path", async () => {
		const fetchMock = mockFetch(200, { code: 0, message: "OK" })
		;(global as any).fetch = fetchMock
		await new ComgateClient(OPTS).cancel("AB12-CD34")
		expect(fetchMock.mock.calls[0][0]).toBe("https://payments.comgate.cz/v2.0/payment/transId/AB12-CD34.json")
		expect(fetchMock.mock.calls[0][1].method).toBe("DELETE")
	})

	it("PUT capturePreauth sends the amount", async () => {
		const fetchMock = mockFetch(200, { code: 0, message: "OK" })
		;(global as any).fetch = fetchMock
		await new ComgateClient(OPTS).capturePreauth("AB12-CD34", 500)
		expect(fetchMock.mock.calls[0][0]).toBe("https://payments.comgate.cz/v2.0/preauth/transId/AB12-CD34.json")
		expect(fetchMock.mock.calls[0][1].method).toBe("PUT")
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ amount: 500 })
	})

	it("DELETE cancelPreauth uses the preauth path", async () => {
		const fetchMock = mockFetch(200, { code: 0, message: "OK" })
		;(global as any).fetch = fetchMock
		await new ComgateClient(OPTS).cancelPreauth("AB12-CD34")
		expect(fetchMock.mock.calls[0][0]).toBe("https://payments.comgate.cz/v2.0/preauth/transId/AB12-CD34.json")
		expect(fetchMock.mock.calls[0][1].method).toBe("DELETE")
	})
})

describe("verifySecret", () => {
	const client = new ComgateClient(OPTS)
	it("accepts the matching secret", () => {
		expect(client.verifySecret("topsecret")).toBe(true)
	})
	it("rejects a wrong secret", () => {
		expect(client.verifySecret("nope")).toBe(false)
	})
	it("rejects non-strings", () => {
		expect(client.verifySecret(undefined)).toBe(false)
		expect(client.verifySecret(12345)).toBe(false)
	})
})
