# AGENTS.md — uSwap browser extension

Guidance for agents working in this repo. Read this before
touching the manifest, the bus, content scripts, or the panel.

## Prime directive: full feature parity across Chrome and Firefox

**One source tree, two MV3 targets. Every user-facing feature MUST work
identically on Chrome and Firefox.** Build target is `EXT_TARGET`
(`chrome` default, `firefox` opt-in) — there is **no Firefox fork**. Platform
differences are branched behind the build flag in `src/core/target.ts`
(`IS_FIREFOX` / `IS_CHROME`) so the unused path is dead-code-eliminated.

When you add or change a feature:

1. **Implement it for both targets.** Never ship a capability that only works on
   one browser. If a Web/MV3 API exists on only one engine, build a parity path
   for the other (see the panel transport below for the canonical example).
2. **Prefer a single shared mechanism over per-browser branches.** Branch only
   where the platform genuinely forces it (panel surface, background type,
   crypto host). The known, allowed branches are enumerated in `README.md`
   ("Targets" table) and `manifest.config.ts`. Don't add new ones casually.
3. **Verify on both.** `bun run build:all` must pass; `bun run lint:firefox`
   must report 0 errors (AMO validation). Runtime-test the feature in both
   Chrome (`dist/`) and Firefox (`dist/firefox/`).

If a change can't reach parity, that's a design problem to solve, not a
Chrome-only feature to ship.

## window.peer transport — two paths, one contract

The page contract is `window.peer` (per Peer's build-your-own-extension spec).
**The APP owns `window.peer` (`reference/window-peer-bridge.ts`) — the
extension never injects it.** No MAIN-world content script, no script injection,
no eval — identical mechanism on Chrome and Firefox (this is what keeps AMO's
linter clean). The app installs `window.peer` only after a valid handshake, so a
plain tab with no extension never gets one (`isExtensionPresent()` stays false).
Two transports, picked by whether the app is top-level or embedded:

### A. App in a normal tab (`app.uswap.net`)
```
window.peer (app-owned)    reference/window-peer-bridge.ts (app-side, incl. for reference)
  ⇅ window.postMessage (same window)
relay (ISOLATED world)     src/content/peer-relay.content.ts
  ⇅ chrome.runtime sendMessage + long-lived Port
background
```
- Handshake: the app posts `syn`; the ISOLATED relay answers `relay-ready`, and
  the app installs `window.peer` over the same-window channel.
- **The relay is deliberately import-free** (a self-contained classic IIFE).
  crxjs splits any content script with ES imports into a loader that does a
  dynamic `import()`, which fails silently in Firefox's content-script sandbox —
  so the relay must inline its bus constants/guards (keep them in sync with
  `core/bus/protocol.ts`).
- **Firefox needs the app origins in `host_permissions`** (not just
  `content_scripts.matches`) to inject the relay — they're added Firefox-only in
  `manifest.config.ts`. On Firefox MV3 these are user-controlled, so the tab path
  activates after the user grants app.uswap.net access (the panel needs no grant).

### B. App in the extension panel (side panel / sidebar)
```
window.peer (parent bridge)   reference/window-peer-bridge.ts (app-side, incl. for reference)
  ⇅ window.postMessage to window.parent
panel relay                   src/sidepanel/peer-bridge.ts
  ⇅ chrome.runtime sendMessage + long-lived Port
background
```
- The panel is an extension page that iframes the app cross-origin. **Firefox
  does NOT inject content scripts into an app frame whose parent is a
  `moz-extension://` page**, so the content-script transport (A) cannot work in
  the panel. The panel page itself relays the bus instead.
- **This path is identical on Chrome and Firefox** — it's the parity mechanism.
  Even though Chrome *would* inject the content script into the panel iframe, the
  app's parent-bridge overwrites `window.peer` on the panel handshake so both
  browsers use path B in the panel. Do not reintroduce a panel dependency on
  content-script injection.
- **Security anchor:** the app installs the parent bridge only on a `hello`
  postMessage whose `event.origin` is a `chrome-extension://` / `moz-extension://`
  origin — a web page cannot forge that, so a malicious site embedding the app
  cannot impersonate the panel. The encrypted capture blob flows panel→app,
  targeted to the app origin.

### Background trust
`sender`/`sender.origin` is authoritative; page payloads are never trusted for
identity. First-party surfaces (the panel — any `chrome-extension://` /
`moz-extension://` sender url) are detected by `src/core/sender.ts`
(`isFirstPartySender`) and are implicitly connected (they bypass the website
consent gate and are attributed to `FIRST_PARTY_ORIGIN`). Event routing is keyed
per-connection (`connKeyForSender`, by `documentId` with a url fallback for
extension pages), never per-tab — the panel is not a tab.

## Validation notes
- The **panel** path is the primary surface and is validated on Firefox via
  WebDriver BiDi (panel page iframes the app; `window.peer.getVersion()` round
  trips). The **tab** path can NOT be exercised in headless tooling — neither
  BiDi `webExtension.install` nor `web-ext run` (headless) reliably triggers
  content-script injection into a BiDi-navigated context, so the relay never runs
  there. Validate the tab path in a real interactive Firefox (load the temp
  add-on, grant app.uswap.net access, open app.uswap.net in a tab, check
  `window.peer`). The code is a standard self-contained content script.

## Checklist before committing
- [ ] Feature works on Chrome **and** Firefox (parity directive).
- [ ] `bun run build:all` passes.
- [ ] `bun run lint:firefox` → 0 errors.
- [ ] No new per-browser branch unless platform-forced (and documented).
- [ ] Security invariants in `README.md` intact (plaintext session material
      never leaves the extension; capture gated; no API keys in the extension).
