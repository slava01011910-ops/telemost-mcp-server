# Changelog

All notable changes to `telemost-mcp-server` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-07-13

### Changed
- Default per-call spend cap `MAX_PAYMENT_USDC` raised from `1` to `2.5` so every tool in the catalog
  (the priciest is $2.10) works out of the box. `SESSION_MAX_USDC` stays `10`. Caps are still enforced
  in code before any signature; tighten them via the env vars if you want a stricter limit.
- Spend-cap refusals are now actionable: the message names the call price, the cap value, and the exact
  env var to raise (e.g. `call costs $2.1, exceeds MAX_PAYMENT_USDC=$1. Raise MAX_PAYMENT_USDC to allow this call.`).

### Added
- Offline unit tests for the spend-cap policy (per-call cap, session-cap accumulation, network selection,
  actionable refusal text, and 402 price parsing). Tests touch no network and run in CI via `npm test`.

### Fixed
- The pre-signing policy check now reads the x402 payment challenge from the `payment-required` response
  header (base64 JSON), falling back to the response body. Previously it read only the body, which the
  server leaves empty, so the per-call/session caps never saw the real price or network.
- A missing or malformed price in the payment challenge is now refused before signing instead of being
  treated as free ($0).

## [0.2.1] - 2026-07-12

### Changed
- Moved to a standalone public repository and re-published via npm Trusted Publishing (OIDC) with
  provenance attestation enabled. No functional changes.

## [0.2.0] - 2026-07-11

### Added
- Initial public npm release. Thin stdio MCP bridge to the Telemost x402 API: tools are generated at
  startup from the live `/openapi.json`, and each paid tool call is paid from the agent's own USDC wallet
  via x402. Free `telemost_catalog` tool for listing everything with no payment.

[0.2.2]: https://github.com/slava01011910-ops/telemost-mcp-server/releases/tag/v0.2.2
[0.2.1]: https://github.com/slava01011910-ops/telemost-mcp-server/releases/tag/v0.2.1
[0.2.0]: https://github.com/slava01011910-ops/telemost-mcp-server/releases/tag/v0.2.0
