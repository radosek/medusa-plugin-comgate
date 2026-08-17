import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * The Comgate client portal probes the configured PUSH URL with a GET when the shop
 * connection is saved. Medusa's payment webhook route only accepts POST, so without
 * this the probe sees a 404 and the portal may flag the URL. Real notifications are
 * POSTs handled by Medusa's `/hooks/payment/comgate_comgate`.
 */
export const GET = async (_req: MedusaRequest, res: MedusaResponse) => {
	res.status(200).json({ ok: true, provider: "comgate", note: "PUSH notifications must be sent as POST" })
}
