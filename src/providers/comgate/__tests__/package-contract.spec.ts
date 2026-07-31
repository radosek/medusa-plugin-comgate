import { readFileSync } from "node:fs"
import { join } from "node:path"
import ComgateProviderService from "../service"
import providerExport from "../index"

/**
 * These guard the consumer-facing contract, not internal behaviour. Breaking any
 * of them breaks every merchant's `medusa-config.ts` on upgrade, and it fails
 * silently at boot rather than in a build, so unit tests wouldn't catch it.
 */
const pkg = JSON.parse(readFileSync(join(__dirname, "../../../../package.json"), "utf8"))

describe("package contract", () => {
	it("keeps the provider identifier stable", () => {
		// The resolved provider id merchants use is `pp_comgate_comgate`, derived
		// from this. Changing it silently orphans existing payment sessions.
		expect(ComgateProviderService.identifier).toBe("comgate")
	})

	it("keeps the documented subpath export resolvable", () => {
		// README tells merchants to `resolve: "medusa-plugin-comgate/providers/comgate"`.
		expect(pkg.exports["./providers/*"]).toBe("./.medusa/server/providers/*/index.js")
	})

	it("ships the built plugin output", () => {
		// `.medusa/server` is what the exports map points at; dropping it from
		// `files` publishes a package that resolves to nothing.
		expect(pkg.files).toEqual(expect.arrayContaining(["dist", ".medusa/server"]))
	})

	it("stays installable on any Medusa 2.x host", () => {
		// Pinning this to an exact version would force-upgrade every consumer.
		expect(pkg.peerDependencies["@medusajs/framework"]).toBe("2.x")
	})

	it("keeps the Medusa plugin keywords used by the integrations listing", () => {
		expect(pkg.keywords).toEqual(
			expect.arrayContaining(["medusa-v2", "medusa-plugin-integration", "medusa-plugin-payment"]),
		)
	})

	it("exports the provider as a module provider default export", () => {
		expect(providerExport).toBeDefined()
	})

	it("implements every payment-provider method Medusa calls", () => {
		// Medusa invokes these by name at runtime; a rename or accidental removal
		// surfaces as a boot/runtime failure in the merchant's app, not here.
		const required = [
			"initiatePayment",
			"authorizePayment",
			"capturePayment",
			"refundPayment",
			"cancelPayment",
			"deletePayment",
			"retrievePayment",
			"updatePayment",
			"getPaymentStatus",
			"getWebhookActionAndData",
		]
		for (const method of required) {
			expect(typeof (ComgateProviderService.prototype as any)[method]).toBe("function")
		}
	})
})
