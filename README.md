# @uswap/browser-extension

The uSwap browser extension — **one source tree, two MV3 build targets: Chrome
and Firefox.** The toolbar icon opens a **panel hosting the real uSwap web app**
(Chrome side panel / Firefox sidebar) — users execute full uSwap flows inside the
panel. Feature modules add browser-integration superpowers on top.

> Build target is selected at build time by `EXT_TARGET` (`chrome` default,
> `firefox` opt-in) — there is **no separate Firefox fork**; ~95% of the code is
> shared, and the few platform differences are branched behind a build flag
> (`src/core/target.ts`) so the unused path is dead-code-eliminated.

## Targets

| | Chrome (`dist/`) | Firefox (`dist/firefox/`) |
|---|---|---|
| Panel surface | `side_panel` (`chrome.sidePanel`) | `sidebar_action` (`browser.sidebarAction`) |
| Background | MV3 service worker | MV3 event page (`background.scripts`) |
| @zkp2p crypto + DOM parsing | offscreen document (`chrome.offscreen`) | runs **directly in the background** event page |
| Store / distribution | Chrome Web Store (`.zip`) | AMO (`web-ext` → signed XPI) |
| Min version | Chrome 114+ | Firefox 142+ (declared data permissions) |

Everything else (manifest, permissions, the bus, modules, content scripts) is
identical. `chrome.*` aliases to `browser` on Firefox 109+, so no polyfill is
needed for the extension to function.

## Modules

| Module | Status | What it does |
|---|---|---|
| `peer-capture` | active | Whitelabeled [Peer](https://docs.peer.xyz/developer/build-your-own-extension) metadata bridge: implements `window.peer` for `@zkp2p/sdk`'s `createPeerExtensionSdk()`, drives fiat payment capture (buyer TEE + seller credential flows) for the uSwap onramp. |
| `checkout-pay` | planned | Bitwarden-style overlay on checkout pages (Stripe, Cryptomus, …): one click creates a uSwap pay-mode intent (`/pay/:id`) to buy a virtual card for the cart amount, then autofills card details. |
| `context-bridge` | planned | Right-click a selected crypto address → "Swap via uSwap" → opens bridge creation with that destination. |

### Module rules

- A module may only import from `src/core/*`. Modules never import each other.
- Every manifest permission is annotated with its owning module in
  `manifest.config.ts`.
- New modules: add an entry under `src/modules/<id>/`, export an
  `ExtensionModule`, register it in `src/background/index.ts`. Content scripts
  and permissions are added per-module in `manifest.config.ts`
  (prefer `optional_host_permissions` granted at first use).

## Architecture

`window.peer` reaches the background two ways depending on where the app runs
(see `AGENTS.md` for the full contract + the cross-browser parity rules):

```
TAB: page (app-owned window.peer)    supplied by the web app
  ⇅ window.postMessage (BusRequest/BusResponse/BusEvent)
     relay (ISOLATED world)           src/content/peer-relay.content.ts
       ⇅ chrome.runtime sendMessage + long-lived Port (per-connection event push)

PANEL: app (window.peer parent bridge)  defined by the uSwap web app
  ⇅ window.postMessage to parent panel
     panel relay                      src/sidepanel/peer-bridge.ts
       ⇅ chrome.runtime sendMessage + long-lived Port
       (identical on Chrome + Firefox — no content-script injection in the panel)

background (SW on Chrome / event page on Firefox)   src/background/index.ts
  ├─ bus router → module handlers    src/core/bus/router.ts
  ├─ origin grants                   src/core/storage/origin-grants.ts (storage.local)
  ├─ capture sessions                storage.session (TRUSTED_CONTEXTS, never disk)
  └─ @zkp2p crypto + DOM parsing     src/offscreen/handlers.ts
       ├─ Chrome  → offscreen document (src/offscreen/offscreen.ts, via RPC)
       └─ Firefox → run in-process in the background event page
extension pages
  ├─ panel                           src/sidepanel/  — iframes the uSwap app
  ├─ consent prompts                 src/prompt/     — connect / inline-template approvals
  └─ options                         src/options/    — connected-sites management
```

The background treats `sender.origin` / `sender.tab` as authoritative; nothing
security-relevant is taken from page-supplied payloads.

## Security invariants (do not break)

- Plaintext payment session material (cookies, auth headers, request bodies)
  **never leaves the extension** — only TEE-encrypted blobs are posted to pages.
- Inline provider templates require explicit approval before account access.
- Capture is gated behind per-origin connection approval.
- `storage.local` holds only origin grants. Capture state lives in
  `storage.session` (memory-backed) and is wiped on completion/expiry.
- The extension holds no API keys; curator/maker logic stays in page/backend code.

## Develop

```bash
bun install

# Chrome (default target)
bun run dev            # vite dev server with CRXJS HMR
bun run build          # production build → dist/
bun run package        # dist/ → uswap-extension-<version>.zip

# Firefox
bun run dev:firefox    # vite dev server, Firefox manifest
bun run build:firefox  # production build → dist/firefox/
bun run lint:firefox   # web-ext lint (AMO validation)
bun run run:firefox    # launch Firefox with the extension loaded (temp add-on)
bun run package:firefox # dist/firefox/ → signed-XPI artifact (web-ext build)

bun run build:all      # both targets
bun test               # unit tests (template engine, selectors, redaction)
```

- **Chrome:** load `dist/` via `chrome://extensions` → "Load unpacked".
- **Firefox:** `bun run run:firefox`, or `about:debugging` → "Load Temporary
  Add-on" → `dist/firefox/manifest.json`.

The panel embeds `VITE_USWAP_APP_URL` (default `https://app.uswap.net`, dev
default `http://localhost:5173`). The app must allow framing by the extension:
`Content-Security-Policy: frame-ancestors 'self' chrome-extension: moz-extension:`.

## Payment capture audit — 0.6.10

Compared on 2026-10-11 with the official Chrome Web Store **Peer 0.7.3**
package, the public [branded-extension example](https://github.com/zkp2p/peer-examples/tree/main/branded-extension),
and the current [hosted provider templates](https://api.zkp2p.xyz/providers/wise/transfer_wise.json).
The SDK is pinned to **0.14.8**. The reference templates in `test/fixtures/`
contain public configuration only; account data in tests is invented.

| Supported method | Peer template / proof action | Metadata | Public proof selection |
|---|---|---|---|
| Venmo | venmo / transfer_venmo | JSON history | SENDER_ID + selected index |
| Cash App | cashapp / transfer_cashapp | JSON history | SENDER_ID + selected index |
| Revolut | revolut / transfer_revolut | In-page JSON history | selected index |
| Wise | wise / transfer_wise | POST activity history; one in-page retry | PROFILE_ID + TRANSACTION_ID |
| PayPal | paypal / transfer_paypal | HTML-wrapped JSON from metadata URL | PAYMENT_ID |
| Mercado Pago | mercadopago / transfer_mercadopago | embedded JSON in account HTML | PAYMENT_ID + URL_PARAMS_FROM |
| Monzo | monzo / transfer_monzo | JSON history from metadata URL | TX_ID |
| N26 | n26 / transfer_n26 | In-page GraphQL transfer detail | request body stays encrypted |
| Alipay | alipay / transfer_alipay | HTML / XPath history | TRADE_NO |
| Chime | chime / transfer_chime | In-page GraphQL Pay Anyone detail | request body stays encrypted |
| X Money (USD) | xmoney / transfer_xmoney | GraphQL transfer detail; raw micro-dollar amount | TRANSACTION_ID |
| Luxon | luxon / transfer_luxon | JSON history | TRANSFER_ID |
| Zelle Citi | zelle / transfer_zelle_citi | JSON history | selected index |
| Zelle Chase | zelle / transfer_zelle_chase | JSON history | selected index |
| Zelle Bank of America | zelle / transfer_zelle_bofa | In-page JSON history | selected index |

The Mercado Pago JSON template labels itself `transfer_mercado_pago`; the public
SDK's attestation contract uses `transfer_mercadopago`. We keep the SDK contract
and the published fetch path. No action is inferred from that inconsistent label.

X Money access is optional and limited to `https://x.com/*`. Amount metadata is
reported in micro-dollars (1 USD = 1,000,000 units); consuming apps must convert
that unit explicitly. A captured detail is not proof of a completed payment;
the attestation service remains authoritative. Quote availability depends on
Peer liquidity and the user having access to X Money.

### Findings addressed

- The three legacy Zelle fetch paths return 404. Both legacy bank aliases and
  canonical Peer inputs now resolve to the current bank-specific templates.
  Capture events include the canonical proof target; callers must preserve it.
- Wise history entries can lack a display date. A row remains selectable only
  when its amount, recipient, currency, transfer ID, and profile ID are present.
  Dates are not invented; the TEE verifies the actual transfer separately.
  Empty/incomplete history produces distinct, field-name-only errors. At most
  one history retry uses the authenticated provider tab; there is no loop.
- Both `error` and Peer's `errorMessage` are emitted for compatibility.
- Late extraction, approval, or encryption cannot publish a cancelled, expired,
  superseded, or revoked capture. Status changes cannot revive deleted sessions.
- The website relays expose only Peer calls, rebuild request envelopes, and
  cannot forward extension-only settings or forged offscreen messages.
- Attestation key services are restricted to the public Peer service and uSwap
  domains. Loopback services require a loopback caller. Provider navigation and
  replay targets must belong to the selected payment platform.
- Custom templates require approval before account access or result
  delivery. Closing a consent popup denies the request, and fast decisions do
  not race popup creation.
- Header/body selectors remain private. Nested metadata and per-row proof
  parameters are checked for credential leaks. JSONPath expression evaluation
  is disabled; all supported templates use ordinary path selectors.
- Header replay rules match an exact URL and the extension initiator, reject
  redirects, and are removed after use or background startup. Network reads
  time out, request caches are bounded, and concurrent setup per document is
  rejected.
- Production archives omit the development harness. The Chrome archive excludes
  the nested Firefox build; neither archive includes source maps or repository source files.

### Stable Peer differences and validation limits

Peer 0.7.3 also accepts caller-supplied capture plugins in a sandbox, with plugin
hash verification and capability consent. This release retains its existing
JSON-template engine, which Peer still supports. It does **not** execute downloaded
plugin programs, inject a MAIN-world script, or claim plugin-runtime parity.

Buyer capture was reviewed for all 15 methods: successful HTTP gating, method /
URL / body matching, metadata replay, preprocessing, JSONPath / XPath extraction,
private parameters, row selection, encryption, consent, cancellation, and delivery.
The existing Venmo and Cash App seller-credential code was also reviewed; Peer
0.7.3's current seller-credential entry point supports Cash App and UPI instead.
UPI is outside this extension's supported payment-method list. Identity/register
capture and live seller credential uploads are not newly advertised by this release.

Validation includes the automated capture suite, TypeScript, both production
builds, Firefox lint (zero errors), Chrome and Firefox runtime checks of the
panel bridge and Alipay XPath path, all 15 live template fetches, and encryption
of synthetic session material using the live public attestation endpoint.
These last checks read public key material; they do not submit payment proofs,
create orders, or exercise real payment accounts. Successful capture and proof
verification in each logged-in payment account still need user testing.

The dependency audit reduced 55 advisories to one unresolved build-tool advisory
in `web-ext → @devicefarmer/adbkit → node-forge` ([upstream advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv)).
The registry's latest node-forge is still affected. This Android tooling dependency
is absent from both browser archives and is not used by desktop payment capture.
Firefox lint also reports static warnings in bundled React/JSONPath library code;
no eval permission or remote executable code is enabled.

### Testing the Chrome ZIP

Disable the installed uSwap extension first so only one relay is active. Extract
`uswap-extension-0.6.11.zip`, open `chrome://extensions`, turn on Developer mode,
choose **Load unpacked**, and select the extracted folder containing `manifest.json`.
Reload the uSwap tab and retry verification in the account that sent the payment.
For an already paid order, do not send another payment. Report the exact new error
if verification still fails. GitHub releases do not update the Chrome Web Store
installation automatically.


## 0.6.11 — Wise identifier collision and tab cleanup

The 0.6.10 defense-in-depth cookie comparison also compared Wise's numeric
PROFILE_ID / TRANSACTION_ID proof parameters with cookie context values. A
public response ID repeated in a context cookie could block an otherwise valid
capture. Only those two numeric fields from the hosted Wise template are now
excluded from the cookie-atom comparison. Full cookie headers, authorization
and secret headers, private selectors, inline templates, and every other
metadata field retain strict checks. No credential value is returned to the app.

Failed verification now returns to the requesting tab and closes the temporary
provider tab too, unless the provider template explicitly requests keeping it
open. Real-account acceptance testing is still required.
