# Implementation plan

1. [x] Add reference-shaped request records, per-session request caching, and
   primary/fallback request selection with focused unit tests.
2. [x] Move capture completion to successful `onResponseStarted`, including
   reference request filtering and response lifecycle tests.
3. [x] Integrate the request cache with buyer metadata resolution and replay,
   preserving uSwap encryption, redaction, consent, and delivery behavior.
4. [x] Remove the Revolut `/api/retail/` heuristic and add a complete live-shape
   Revolut template contract test covering fallback, metadata replay, extraction,
   and selected proof index.
5. [x] Reconcile Chrome/Firefox listener differences, run the full validation
   matrix, review the complete diff against the spec, and version the extension.
6. [ ] Push a public PR, merge it, rebuild and scan artifacts from the exact
   merge commit, publish the release, and return the Chrome download link.

## Plan critique

- Steps 1–2 separate pure matching/cache behavior from browser lifecycle wiring,
  so response timing can be tested without Chrome mocks leaking into metadata
  tests.
- Step 3 is intentionally isolated because it touches encrypted session material
  and is the highest-risk integration point.
- Step 4 prevents Revolut-specific assumptions from surviving inside otherwise
  generic capture code.
- Publishing is last and uses artifacts rebuilt from the merge commit, not the
  feature branch.
