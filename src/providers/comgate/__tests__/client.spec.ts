import { ComgateClient, ComgateError, ComgateUnreachableError } from "../lib/client"

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

describe("create", () => {
	it("always sends prepareOnly: true", async () => {
		const fetchMock = mockFetch(201, { code: 0, message: "OK", transId: "T", redirect: "x" })
		;(global as any).fetch = fetchMock
		await new ComgateClient(OPTS).create({
			price: 1,
			curr: "CZK",
			label: "L",
			refId: "r",
			method: "ALL",
			email: "a@b.cz",
			test: true,
		})
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).prepareOnly).toBe(true)
	})
})

describe("IPv4 relay", () => {
	it("sends X-Proxy-Key to base_url on every call when proxy_key is set", async () => {
		const fetchMock = mockFetch(200, { code: 0, message: "OK" })
		;(global as any).fetch = fetchMock
		const client = new ComgateClient({ ...OPTS, base_url: "https://relay.fly.dev/", proxy_key: "pk" })
		await client.status("T1")
		await client.cancel("T1")
		await client.refund("T1", 100, true)
		for (const [url, init] of fetchMock.mock.calls) {
			expect(url.startsWith("https://relay.fly.dev/v2.0/")).toBe(true)
			expect(init.headers["X-Proxy-Key"]).toBe("pk")
		}
	})

	it("omits X-Proxy-Key when no proxy_key is set", async () => {
		const fetchMock = mockFetch(200, { code: 0, message: "OK" })
		;(global as any).fetch = fetchMock
		await new ComgateClient(OPTS).status("T1")
		expect("X-Proxy-Key" in fetchMock.mock.calls[0][1].headers).toBe(false)
	})
})

describe("retries", () => {
	const ok = { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, message: "OK" }) }

	it("retries thrown network errors with backoff and succeeds", async () => {
		const sleep = jest.fn().mockResolvedValue(undefined)
		const fetchMock = jest
			.fn()
			.mockRejectedValueOnce(new Error("socket closed"))
			.mockRejectedValueOnce(new Error("socket closed"))
			.mockResolvedValue(ok)
		;(global as any).fetch = fetchMock
		await new ComgateClient(OPTS, sleep).status("T1")
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(sleep.mock.calls).toEqual([[1000], [2000]])
	})

	it("gives up after 4 attempts with ComgateUnreachableError", async () => {
		const fetchMock = jest.fn().mockRejectedValue(new Error("socket closed"))
		;(global as any).fetch = fetchMock
		const client = new ComgateClient(OPTS, async () => undefined)
		await expect(client.status("T1")).rejects.toBeInstanceOf(ComgateUnreachableError)
		expect(fetchMock).toHaveBeenCalledTimes(4)
	})

	it("never retries once an HTTP response came back", async () => {
		const fetchMock = mockFetch(400, { code: 1400, message: "bad request" })
		;(global as any).fetch = fetchMock
		const client = new ComgateClient(OPTS, async () => undefined)
		await expect(client.status("T1")).rejects.toBeInstanceOf(ComgateError)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("treats a relay error without a Comgate code as unreachable, without retrying", async () => {
		const fetchMock = mockFetch(502, "<html>bad gateway</html>")
		;(global as any).fetch = fetchMock
		const client = new ComgateClient(OPTS, async () => undefined)
		await expect(client.status("T1")).rejects.toBeInstanceOf(ComgateUnreachableError)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})

describe("secret redaction", () => {
	const basic = Buffer.from("123456:topsecret").toString("base64")
	const opts = { ...OPTS, proxy_key: "proxykey" }

	it("redacts the secret, proxy key and basic token from Comgate error messages", async () => {
		;(global as any).fetch = mockFetch(200, { code: 1400, message: `bad topsecret proxykey ${basic}` })
		const err = await new ComgateClient(opts).status("T1").catch((e) => e)
		expect(err.message).not.toMatch(/topsecret|proxykey/)
		expect(err.message).not.toContain(basic)
		expect(err.message).toContain("[REDACTED]")
	})

	it("redacts credentials from non-JSON and network error messages", async () => {
		;(global as any).fetch = mockFetch(500, "echo topsecret")
		const a = await new ComgateClient(opts).status("T1").catch((e) => e)
		expect(a.message).not.toContain("topsecret")
		;(global as any).fetch = jest.fn().mockRejectedValue(new Error("connect proxykey refused"))
		const b = await new ComgateClient(opts, async () => undefined).status("T1").catch((e) => e)
		expect(b.message).not.toContain("proxykey")
	})
})
