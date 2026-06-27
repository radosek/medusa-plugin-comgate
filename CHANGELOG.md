# Changelog

## 0.1.0

- Initial release: Comgate payment provider for **Medusa v2** using the Comgate REST v2.0 JSON API.
- Implements create, status, authorize, capture, refund, cancel, delete, retrieve, update and webhook (`getWebhookActionAndData`).
- Supports both the standard redirect flow and pre-authorization (capture/release later) via the `preauth` option.
- All six Comgate endpoints verified against the live test API.
