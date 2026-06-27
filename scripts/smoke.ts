/**
 * Live smoke test against the Comgate REST v2.0 test API.
 *
 *   COMGATE_MERCHANT=xxxx COMGATE_SECRET=xxxx bun run smoke [transId]
 *
 * No arg:        create a test payment -> status -> cancel (storno) round-trip.
 * With transId:  just fetch status for that payment (use after paying with a
 *                test card to confirm PAID, then try refund).
 *
 * Drives the provider's ComgateClient directly — no Medusa backend needed.
 */
import { ComgateClient } from "../src/providers/comgate/lib/client"

const merchant = process.env.COMGATE_MERCHANT
const secret = process.env.COMGATE_SECRET
if (!merchant || !secret) {
	console.error("Set COMGATE_MERCHANT and COMGATE_SECRET env vars.")
	process.exit(1)
}
const client = new ComgateClient({ merchant, secret })
const argTransId = process.argv[2]

async function inspect(transId: string) {
	const s = await client.status(transId)
	console.log(`  status=${s.status} price=${s.price} ${s.curr} refId=${s.refId}`)
	return s
}

async function main() {
	if (argTransId === "create") {
		const refId = `refund-${Date.now()}`
		const r = await client.create({
			price: 10000,
			curr: "CZK",
			label: "Refund test",
			refId,
			method: "ALL",
			email: "test@example.com",
			test: true,
		})
		console.log("TRANSID:", r.transId)
		console.log("PAY HERE:", r.redirect)
		return
	}

	if (argTransId === "preauth") {
		const refId = `preauth-${Date.now()}`
		const r = await client.create({
			price: 10000,
			curr: "CZK",
			label: "Preauth test",
			refId,
			method: "ALL",
			email: "test@example.com",
			test: true,
			preauth: true,
		})
		console.log("TRANSID:", r.transId)
		console.log("PAY HERE:", r.redirect)
		console.log("After paying (-> AUTHORIZED):  bun run smoke capture", r.transId)
		return
	}

	if ((process.argv[2] === "capture" || process.argv[2] === "release") && process.argv[3]) {
		const id = process.argv[3]
		const release = process.argv[2] === "release"
		console.log(`\n→ status ${id}`)
		const s = await inspect(id)
		if (s.status !== "AUTHORIZED") {
			console.log("  (not AUTHORIZED — pay the preauth payment first)")
			return
		}
		if (release) {
			console.log("\n→ cancelPreauth (release reserved funds)")
			await client.cancelPreauth(id)
			console.log("  cancelPreauth accepted (code 0)")
		} else {
			console.log("\n→ capturePreauth (full)")
			await client.capturePreauth(id)
			console.log("  capture accepted (code 0)")
		}
		console.log("\n→ status after")
		await inspect(id)
		return
	}

	if (argTransId) {
		console.log(`\n→ status ${argTransId}`)
		const s = await inspect(argTransId)
		if (s.status === "PAID") {
			console.log("\n→ refund (full)")
			await client.refund(argTransId, Number(s.price), true)
			console.log("  refund accepted (code 0)")
		} else {
			console.log(`\n  (not PAID — pay with a test card first to test refund)`)
		}
		return
	}

	const refId = `smoke-${Date.now()}`
	console.log(`\n→ create (test) refId=${refId}`)
	const created = await client.create({
		price: 10000,
		curr: "CZK",
		label: "Smoke test",
		refId,
		method: "ALL",
		email: "test@example.com",
		test: true,
	})
	console.log("  transId:", created.transId, "| redirect:", created.redirect)

	console.log("\n→ status")
	await inspect(created.transId!)

	console.log("\n→ cancel (storno, works while PENDING)")
	await client.cancel(created.transId!)
	console.log("  cancel accepted (code 0)")

	console.log("\n→ status after cancel")
	await inspect(created.transId!)

	console.log("\n✓ create + status + cancel verified live.")
	console.log("  refund / capturePreauth need a PAID / AUTHORIZED payment:")
	console.log("  pay the redirect URL with a test card, then: bun run smoke <transId>")
}

main().catch((e) => {
	console.error("\n✗ smoke failed:", e instanceof Error ? e.message : e)
	process.exit(1)
})
