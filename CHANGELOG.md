# Changelog

## 0.2.1

- **Fix: refunds sent an invalid amount to Comgate.** The Payment Module passes
  `refund.raw_amount` (`{ value, precision }`) to `refundPayment`; that shape has no
  `.numeric`, so the amount was converted to `NaN`. All `BigNumberInput` shapes
  (number, string, `BigNumber`, raw) are now handled, and an unusable amount throws
  instead of silently sending a bad request.
- Fix: `.env.example` shipped `COMGATE_TEST=1`, but the documented config checks
  `=== "true"` — that combination silently ran **production** payments. The documented
  expression now fails safe: only an explicit `false`/`0` selects production, matching
  the provider's own sandbox default.
- Tests are typechecked again via `tsconfig.test.json` (`bun run typecheck`), fixing
  missing `jest`/`node` types in editors. Build output still excludes tests.
- Bump Medusa dev dependencies to 2.18.0 (`peerDependencies` stays `2.x`).

## 0.1.0

- Initial release: Comgate payment provider for **Medusa v2** using the Comgate REST v2.0 JSON API.
- Implements create, status, authorize, capture, refund, cancel, delete, retrieve, update and webhook (`getWebhookActionAndData`).
- Supports both the standard redirect flow and pre-authorization (capture/release later) via the `preauth` option.
- All six Comgate endpoints verified against the live test API.
