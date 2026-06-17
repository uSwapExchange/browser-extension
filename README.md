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
| Min version | Chrome 111+ | Firefox 128+ (`world:'MAIN'` + DNR `modifyHeaders`) |

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
TAB: page (window.peer, MAIN world)   src/content/peer-page-api.main.ts
  ⇅ window.postMessage (BusRequest/BusResponse/BusEvent)
     relay (ISOLATED world)           src/content/peer-relay.content.ts
       ⇅ chrome.runtime sendMessage + long-lived Port (per-connection event push)

PANEL: app (window.peer parent bridge)  reference/window-peer-bridge.ts (app-side, incl. for reference)
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
- Inline provider templates require an explicit post-extraction approval prompt.
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
