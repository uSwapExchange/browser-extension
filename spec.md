# Peer reference capture lifecycle

## Goal

Replace uSwap's independently reimplemented provider-request capture lifecycle
with the behavior of Peer's published example extension at commit
`f0203fdb430b1660b3ee617f0d4c1e86e43283d4`, while preserving uSwap's public
extension API, browser adapters, and security boundaries.

The provider template must remain the authority for request matching, replay,
and transaction extraction. Provider-specific heuristics must not reinterpret
those semantics.

## User flow

1. The uSwap page calls `window.peer.authenticate`.
2. The extension fetches and parses the provider template.
3. The extension opens the template's authentication page.
4. The extension observes only requests matching the template's primary URL,
   fallback URL, or metadata URL patterns for that tab.
5. Request method, body, and headers are cached by browser request ID.
6. A request becomes eligible only after a successful 2xx
   `onResponseStarted`.
7. The metadata engine selects the primary request first and the fallback only
   when no primary request exists.
8. If `metadataUrl` is configured, the selected request supplies authenticated
   context and the canonical metadata request is replayed. When
   `shouldReplayRequestInPage` is true, replay happens in the authenticated
   provider tab.
9. The response is extracted using the template's
   `transactionsExtraction`. The selected row's original index is preserved for
   proof generation.
10. Only encrypted session material, public metadata, and template-derived
    params are returned to uSwap.

## Requirements

- Match Peer's primary/fallback selection and metadata replay semantics.
- Wait for a successful provider response before accepting capture context.
- Ignore extension-initiated requests, replay requests, OPTIONS, HEAD, and
  irrelevant browser resource types exactly as the reference engine does.
- Track multiple candidate requests for the active tab rather than committing
  to the first request headers observed.
- Preserve request bodies, request headers, response headers, status, and
  original request URL/method needed by template selectors.
- Honor:
  - `urlRegex`, `method`, and `bodyRegex`
  - `fallbackUrlRegex`, `fallbackMethod`, and `fallbackBodyRegex`
  - `metadataUrl`, `metadataUrlMethod`, and `metadataUrlBody`
  - `shouldReplayRequestInPage`
  - `preprocessRegex`
  - JSONPath and XPath `transactionsExtraction`
  - `paramNames` and `paramSelectors`
- Preserve unknown provider-template fields without exposing them to the page.
- Remove the v0.6.6 Revolut-wide `/api/retail/` context heuristic and its
  guessed authentication-header classifier.
- Preserve the existing `window.peer` contract, payment-row picker,
  per-row params, redaction checks, inline-template consent, capture timeout,
  optional host permissions, Chrome MV3 support, and Firefox support.
- Preserve uSwap's current Revolut all-pockets navigation adjustment as the
  sole provider-specific wrapper behavior. It may change only `authLink`; it
  must not alter matching, replay, extraction, or proof parameters.

## Data model

Each active authentication tab owns:

- one capture session;
- a request cache keyed by browser `requestId`;
- zero or more completed 2xx request records.

A request record contains:

- tab and browser request IDs;
- URL, method, resource type, and initiator;
- request body or form data;
- request headers;
- response headers and status;
- completion timestamp.

Sensitive values remain inside extension storage/offscreen encryption and are
never included in page-visible metadata.

## Error behavior

- Non-2xx provider requests are retained only for diagnostics and cannot become
  proof context.
- Missing primary/fallback context remains pending until timeout rather than
  guessing another endpoint.
- Cross-origin or non-HTTPS `metadataUrl` replay is rejected.
- Replay HTTP failures produce a specific user-facing error and wipe encrypted
  session state.
- Malformed extraction results do not produce a proof candidate.

## Explicitly out of scope

- Changing Peer's hosted provider templates.
- Changing attestation-service validation or uSwap's server fulfillment flow.
- Adding new payment rails.
- AMO warning cleanup unrelated to capture correctness.
- Mobile/external-action execution from the template's `mobile` block.

## Testing strategy

- Unit-test request matching, including body-filtered primary and fallback
  requests.
- Unit-test the 2xx response-completion gate and rejection of replay,
  extension-initiated, HEAD/OPTIONS, and irrelevant resource types.
- Unit-test primary-over-fallback precedence.
- Unit-test `metadataUrl` replay from primary and fallback context, including
  in-page replay and same-origin rejection.
- Keep transaction extraction, param generation, redaction, and concurrent
  replay-rule tests green.
- Add a Revolut template contract test using the complete live template shape:
  primary, fallback, metadata replay, root-array extraction, and original
  index.
- Run typecheck, complete test suite, Chrome build, Firefox build, packaging,
  and artifact security scans before publishing.
