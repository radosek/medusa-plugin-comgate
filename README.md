# medusa-payment-comgate-v2

[Comgate](https://www.comgate.cz/) payment provider for **Medusa v2**. Comgate is a Czech payment gateway (cards, Apple Pay / Google Pay, Czech & Slovak bank buttons, Twisto, etc).

[Comgate API docs](https://apidoc.comgate.cz/en/) | [Medusa Payment Module](https://docs.medusajs.com/resources/commerce-modules/payment)

## Features

- Redirect (background / `prepareOnly`) checkout flow.
- Optional pre-authorization mode (reserve now, capture later).
- Capture, cancel, refund from the admin dashboard.
- Background notification (webhook) handling via Medusa's `/hooks/payment/comgate_*` endpoint.

## Install

```bash
bun add medusa-payment-comgate-v2
```

## Configure

Add the provider to the Payment Module in `medusa-config.ts`:

```ts
module.exports = defineConfig({
  // ...
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-comgate-v2/providers/comgate",
            id: "comgate",
            options: {
              merchant: process.env.COMGATE_MERCHANT,
              secret: process.env.COMGATE_SECRET,
              test: process.env.COMGATE_TEST === "true",
              // optional:
              // preauth: false,
              // lang: "cs",
              // country: "CZ",
              // label: "My Store",
              // method: "ALL",
            },
          },
        ],
      },
    },
  ],
})
```

### Options

| Option           | Required | Default | Description |
|------------------|----------|---------|-------------|
| `merchant`       | yes      | —       | Comgate e-shop identifier. |
| `secret`         | yes      | —       | Password for background communication. |
| `test`           | no       | `true`  | Test mode. |
| `preauth`        | no       | `false` | Create pre-authorizations; capture later. |
| `lang`           | no       | `cs`    | Gateway / e-mail language (ISO 639-1). |
| `country`        | no       | `ALL`   | Payer country (ISO 3166-1). |
| `label`          | no       | `Order` | Statement label, 1–16 chars. |
| `method`         | no       | `ALL`   | Payment method, or `ALL` to let the payer choose. |
| `url_paid` / `url_cancelled` / `url_pending` | no | — | Override per-merchant return URLs. |
| `base_url`       | no       | `https://payments.comgate.cz/v1.0` | API base url. |

## Pre-authorization

To run both a direct-capture and a pre-auth provider, register the module twice with different `id`s and `options.preauth`:

```ts
providers: [
  { resolve: "medusa-payment-comgate-v2/providers/comgate", id: "comgate", options: { /* preauth: false */ } },
  { resolve: "medusa-payment-comgate-v2/providers/comgate", id: "comgate-preauth", options: { preauth: true } },
]
```

The provider id used in the storefront / API is `pp_comgate_comgate` (and `pp_comgate-preauth_comgate-preauth`).

## How it works

Uses the Comgate **REST v2.0 JSON API** (`https://payments.comgate.cz/v2.0/...`, HTTP Basic auth).

1. **`initiatePayment`** → `POST /v2.0/payment.json`. Returns `data.redirect` — send the payer there. The Medusa payment session id is passed as Comgate `refId`.
2. The payer pays on the Comgate gateway.
3. **Webhook** → Comgate POSTs a JSON background notification to `/hooks/payment/comgate_comgate`. `getWebhookActionAndData` constant-time-verifies the echoed `secret`, resolves the session by `refId`, and maps `PAID → captured`, `AUTHORIZED → authorized`, `CANCELLED → failed`.
4. **`capturePayment`** → no-op for direct capture (already `PAID`); `PUT /v2.0/preauth/transId/{id}.json` in pre-auth mode.
5. **`refundPayment`** → `POST /v2.0/refund.json`. **`cancelPayment`** → `DELETE /v2.0/payment/transId/{id}.json` (storno, PENDING only) or `DELETE /v2.0/preauth/transId/{id}.json` in pre-auth mode.

> Per Comgate's spec, order fulfillment must be driven by the **background notification**, not the payer's browser redirect, since redirect params are user-controlled. Comgate retries the PUSH up to 1000× until it gets a 2xx — Medusa's webhook handling is idempotent.

> Comgate authenticates the PUSH by echoing the merchant `secret` in the body (no HMAC header). Restrict the webhook to Comgate's IP ranges (`https://payments.comgate.cz/ips-v4`) as a first layer; the secret check is the second.

## Comgate Client Portal setup

In the [Client Portal](https://portal.comgate.cz/) → *Integrace → Nastavení obchodů → Přidat propojení obchodu*:

| Field (CS) | Field (EN) | Value |
|---|---|---|
| Heslo | Password | → your `COMGATE_SECRET` |
| Povolený způsob založení platby | Payment creation method | **HTTP POST protokol - backend** (recommended) |
| **Url pro předání výsledku platby** | **Background result URL (PUSH)** | `https://<your-backend>/hooks/payment/comgate_comgate` |
| Url zaplacený | Paid redirect | storefront order-confirmation page |
| Url zrušený | Cancelled redirect | storefront cart / retry page |
| Url nevyřízený | Pending redirect | storefront "payment processing" page |
| Povolené IP adresy / Povolit všechny IP | Allowed IPs | your backend's egress IP, or allow-all |

**The PUSH URL is mandatory** — without it payments never confirm in Medusa. The three redirect URLs are browser-facing only and **non-authoritative** (the payer can forge their params); never mark an order paid from them. Order state is driven solely by the PUSH webhook.

### Storefront redirect URLs (Medusa Next.js starter)

Comgate substitutes `${id}` (transId) and `${refId}` (Medusa payment session id). Example for the official starter:

```
Paid:      https://<storefront>/${countryCode}/order/confirmed?refId=${refId}
Cancelled: https://<storefront>/${countryCode}/cart?payment=cancelled
Pending:   https://<storefront>/${countryCode}/order/pending?id=${id}
```

Map these to your actual routes. The storefront should still re-query the order/payment status server-side before showing "paid".

> **Web/Mobile Checkout SDK** checkboxes: leave **off**. This provider uses Comgate's hosted redirect flow, not the embedded checkout SDKs.

## Configure the webhook

In the Comgate portal set the **background-notification URL** ("Url pro předání výsledku platby") to:

```
https://<your-backend>/hooks/payment/comgate_comgate
```

## Development

```bash
bun install
bun run build      # tsc -> dist
bun run test       # jest unit tests (mocked fetch)
```

Live smoke test against the Comgate v2.0 test API (no Medusa backend needed):

```bash
COMGATE_MERCHANT=xxxx COMGATE_SECRET=xxxx bun run smoke
```

It creates a test payment and prints the `redirect` URL — open it and pay with a Comgate test card to see the status flip to `PAID`. Your IP must be allowed on the shop link (portal → *Povolené IP adresy* / *Povolit všechny IP*).

## Publishing to npm / Medusa integrations page

This is packaged as a Medusa v2 plugin. To list it for free on the [Medusa integrations page](https://medusajs.com/integrations/), the `package.json` already includes the required keywords (`medusa-v2`, `medusa-plugin-integration`, `medusa-plugin-payment`).

```bash
bun run plugin:build   # medusa plugin:build -> .medusa/server
npm publish            # public package
```

Once published with those keywords, the plugin is picked up automatically by the Medusa integrations listing.

## License

MIT
