<p align="center">
  <img src="https://raw.githubusercontent.com/radosek/medusa-plugin-comgate/main/assets/comgate-logo.png" alt="Comgate" width="280" />
</p>

# medusa-plugin-comgate

This plugin is a [Comgate](https://www.comgate.cz/) payment provider for **Medusa v2**. Comgate is a Czech payment gateway. It accepts cards, Apple Pay, Google Pay, Czech and Slovak bank buttons, Twisto and other methods.

> **Disclaimer:** This plugin is an unofficial integration from the community. **Comgate Payments, a.s. does not own, approve or maintain it.** "Comgate" and the Comgate logo are trademarks of their owner. This document uses them only to identify the payment gateway.

[npm](https://www.npmjs.com/package/medusa-plugin-comgate) | [Medusa integrations listing](https://medusajs.com/integrations/medusa-plugin-comgate) | [Comgate API docs](https://apidoc.comgate.cz/en/) | [Medusa Payment Module](https://docs.medusajs.com/resources/commerce-modules/payment)

## Features

- Checkout with a redirect to the Comgate gateway (background create with `prepareOnly`).
- Optional pre-authorization mode. The gateway reserves the amount now, and you capture it later.
- Capture, cancel and refund from the admin dashboard.
- The plugin receives PUSH notifications (the webhook) at the Medusa endpoint `/hooks/payment/comgate_*`.

## Install

```bash
bun add medusa-plugin-comgate
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
            resolve: "medusa-plugin-comgate/providers/comgate",
            id: "comgate",
            options: {
              merchant: process.env.COMGATE_MERCHANT,
              secret: process.env.COMGATE_SECRET,
              // Fail safe: only an explicit "false"/"0" switches to production,
              // so a typo or an unset var stays in the sandbox.
              test: !["false", "0"].includes((process.env.COMGATE_TEST ?? "").toLowerCase()),
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
| `merchant`       | yes      | —       | The e-shop identifier in Comgate. |
| `secret`         | yes      | —       | The password for server-to-server calls. |
| `test`           | no       | `true`  | Test mode. |
| `preauth`        | no       | `false` | Create pre-authorizations. You capture them later. |
| `lang`           | no       | `cs`    | The language of the gateway and the e-mails (ISO 639-1). |
| `country`        | no       | `ALL`   | The country of the payer (ISO 3166-1). |
| `label`          | no       | `Order` | The label on the bank statement, 1–16 characters. |
| `method`         | no       | `ALL`   | The payment method. `ALL` lets the payer select the method. |
| `url_paid` / `url_cancelled` / `url_pending` | no | — | Return URLs. Put your own order ID in them. Refer to the note below. |
| `base_url`       | no       | `https://payments.comgate.cz` | The API base URL. Each path includes the `/v2.0` prefix. Comgate accepts only IPv4 addresses on its allow list and returns `1400` for other calls. If your host sends requests over IPv6, set this to an IPv4 relay. |
| `proxy_key`      | no       | —       | The shared secret of the relay in `base_url`. The plugin sends it as the `X-Proxy-Key` header on each API call. Do not set it if you call Comgate directly. |

**Retries and credentials:**

- Each try stops after 15 s.
- If a network error occurs and no HTTP response comes back, the plugin tries the call again. It makes up to 4 tries and waits 1 s, 2 s and 3 s between them. Thus a relay that starts after an auto-suspend does not cause a failure.
- Refunds and pre-auth captures try again only if the connection did not open (refused, DNS error, connect timeout). If the connection stops during a request, the money can already be moved. In that case, the plugin returns the error.
- The plugin does not try a request again if an HTTP response came back.
- The plugin removes the credentials (`secret`, the Basic token, `proxy_key`) from all errors and log messages.

## Pre-authorization

You can use a direct-capture provider and a pre-auth provider together. To do this, register the module two times with a different `id` and `options.preauth`:

```ts
providers: [
  { resolve: "medusa-plugin-comgate/providers/comgate", id: "comgate", options: { /* preauth: false */ } },
  { resolve: "medusa-plugin-comgate/providers/comgate", id: "comgate-preauth", options: { preauth: true } },
]
```

The storefront and the API use the provider ID `pp_comgate_comgate`. The pre-auth provider ID is `pp_comgate-preauth_comgate-preauth`.

## How it works

The plugin uses the Comgate **REST v2.0 JSON API** (`https://payments.comgate.cz/v2.0/...`) with HTTP Basic authentication.

1. **`initiatePayment`** → `POST /v2.0/payment.json`. The response has `data.redirect`. Send the payer to this URL. The plugin sends the ID of the Medusa payment session as the Comgate `refId`.
2. The payer pays on the Comgate gateway.
3. **Webhook** → Comgate sends a PUSH notification (JSON or form-encoded) to `/hooks/payment/comgate_comgate`. `getWebhookActionAndData` does these checks:
   - If the PUSH notification has a `secret`, the `secret` must be correct. The plugin compares it in constant time.
   - The plugin gets the **canonical** status, price, currency and `refId` from `GET /v2.0/payment/transId/{id}.json`. It does not use these values from the PUSH body. If this API is not available, the plugin uses the PUSH body **only** if its `secret` is correct. In all other conditions, it does nothing.
   - The Comgate `refId` must be equal to the PUSH `refId` (the ID of the Medusa payment session). The `transId` stored on the payment session must be empty or equal to the PUSH `transId`.
   - The canonical price and currency must be equal to the amount and currency of the payment session (anti-tamper check).
   - The plugin maps `PAID → captured`, `AUTHORIZED → authorized`, `CANCELLED → failed` and `PENDING → pending`. It converts `amount` from Comgate minor units to the Medusa decimal value.

   If a check fails, the plugin returns `not_supported` and logs an error. The payment does not change. Medusa ignores `failed`, so a late `CANCELLED` after `PAID` changes nothing. A second `PAID` does not capture again.
4. **`capturePayment`** → For direct capture, this step does nothing because the payment is already `PAID`. In pre-auth mode, the plugin calls `PUT /v2.0/preauth/transId/{id}.json`.
5. **`updatePayment`** → Comgate cannot change the amount of a payment. If the amount or currency changes, the plugin cancels the old Comgate payment. Then it creates a new payment with the same `refId`.
6. **`refundPayment`** → `POST /v2.0/refund.json`. The plugin sends the `test` flag of the original payment. If the flags are different, Comgate returns error 1402. **`cancelPayment`** → `DELETE /v2.0/payment/transId/{id}.json` (storno, only for PENDING). In pre-auth mode, the plugin calls `DELETE /v2.0/preauth/transId/{id}.json`.

> The Comgate specification requires that the **PUSH notification** controls order fulfillment. The browser redirect of the payer must not control it, because the payer can change the redirect parameters. Comgate sends the PUSH notification again, up to 1000 times, until it gets a 2xx response. The webhook in Medusa is idempotent.

> Comgate authenticates the PUSH notification with the merchant `secret` in the body. It does not send an HMAC header. As the first layer of protection, accept webhook calls only from the Comgate IP ranges (`https://payments.comgate.cz/ips-v4`). The `secret` check is the second layer.

## Comgate Client Portal setup

Go to the [Client Portal](https://portal.comgate.cz/) → *Integrace → Nastavení obchodů → Přidat propojení obchodu*. Set these fields:

| Field (CS) | Field (EN) | Value |
|---|---|---|
| Heslo | Password | → your `COMGATE_SECRET` |
| Povolený způsob založení platby | Payment creation method | **HTTP POST protokol - backend** (recommended) |
| **Url pro předání výsledku platby** | **Background result URL (PUSH)** | `https://<your-backend>/hooks/payment/comgate_comgate` |
| Url zaplacený | Paid redirect | storefront order-confirmation page |
| Url zrušený | Cancelled redirect | storefront cart / retry page |
| Url nevyřízený | Pending redirect | storefront "payment processing" page |
| Povolené IP adresy / Povolit všechny IP | Allowed IPs | your backend's egress IP, or allow-all |

**You must set the PUSH URL.** Without it, Medusa never gets the payment confirmation.

When you save the connection, the portal sends a `GET` request to the PUSH URL. The Medusa webhook route accepts only `POST`. Thus the plugin returns `200` for `GET` on that path, and the portal check passes.

The three redirect URLs are only for the browser. They are **not authoritative**, because the payer can change their parameters. Do not mark an order as paid from a redirect. Only the PUSH notification changes the order state.

### Storefront redirect URLs (Medusa Next.js starter)

The return page must identify the order. Comgate supports the placeholders `${id}` (the Comgate transId) and `${refId}` (your reference). The placeholders are **case-sensitive**. Comgate replaces them only in the return-URL fields of the **Comgate client portal**, at the time of the redirect.

Comgate uses the API fields `url_paid`, `url_cancelled` and `url_pending` **verbatim**. It does not replace placeholders and does not add parameters. If you set the URLs through the API, you must put the identifier in the URL yourself.

Portal (recommended, Comgate replaces the placeholders):

```
Paid:      https://<storefront>/${countryCode}/order/confirmed?state=paid&id=${id}&refId=${refId}
Cancelled: https://<storefront>/${countryCode}/cart?state=cancelled&id=${id}&refId=${refId}
Pending:   https://<storefront>/${countryCode}/order/pending?state=pending&id=${id}&refId=${refId}
```

API options (verbatim, put in your own ID):

```
url_paid: https://<storefront>/${countryCode}/order/confirmed?refId=<order-id>
```

`refId` is the ID of the Medusa payment session. The return page reads it and finds the order. The redirect is never authoritative. Before the storefront shows "paid", it must get the order or payment status again on the server.

> Do **not** select the **Web/Mobile Checkout SDK** checkboxes. This provider uses the hosted redirect flow of Comgate. It does not use the embedded checkout SDKs.

## Configure the webhook

In the Comgate portal, set the **PUSH notification URL** ("Url pro předání výsledku platby") to:

```
https://<your-backend>/hooks/payment/comgate_comgate
```

## Development

```bash
bun install        # also installs the git hooks (lefthook)
bun run build      # medusa plugin:build -> .medusa/server
bun run test       # jest unit tests (mocked fetch)
bun run check      # format + lint + typecheck + test (what CI runs)
```

The format and lint tools are from [oxc](https://oxc.rs/). `bun run format` changes the files. `bun run lint` only checks them.

`lefthook` runs the format and lint checks on staged files before each commit. It runs the typecheck and the tests before each push. The hooks only *check* files. They do not change files during a commit.

If the format check fails:

1. Run `bun run format`.
2. Stage the files again.

To do a live smoke test against the Comgate v2.0 test API, run this command. You do not need a Medusa backend.

```bash
COMGATE_MERCHANT=xxxx COMGATE_SECRET=xxxx bun run smoke
```

The command creates a test payment and shows the `redirect` URL.

1. Open the `redirect` URL.
2. Pay with a Comgate test card.
3. Make sure that the status changes to `PAID`.

The shop connection must allow your IP address (portal → *Povolené IP adresy* / *Povolit všechny IP*).

## License

MIT

This project is an independent, unofficial integration. Comgate Payments, a.s. does not own or approve it. All Comgate trademarks and logos are the property of their owner.
