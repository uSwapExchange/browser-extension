// @ts-nocheck
// Bundled public Peer capture program, reviewed 2026-11-09. No runtime code loading.
// Source: https://api.zkp2p.xyz/providers/monzo/register_monzo.json
const TRANSACTIONS_URL = /^https:\/\/internal-api\.monzo\.com\/\/?minimal-banking\/transactions\?account_id=[^&#]+&limit=50$/;

function match({ request }) {
  return request.method === "GET" && TRANSACTIONS_URL.test(request.url);
}

function capture({ event, params }) {
  if (!match({ request: event.request })) return null;
  if (event.response.status !== 200 || !event.response.body) return null;
  const payload = JSON.parse(event.response.body);
  if (!payload || !Array.isArray(payload.transactions)) throw new Error("Invalid Monzo transactions response.");
  const handle = typeof params.MONZO_ME_HANDLE === "string" ? params.MONZO_ME_HANDLE.trim().toLowerCase() : "";
  if (!/^[a-z0-9_-]+$/.test(handle)) throw new Error("Enter your Monzo.me handle before verifying.");
  // Capture the session even for an empty account. The attestor proves ownership, not this transaction list.
  return [{ handle, params: { MONZO_ME_HANDLE: handle }, originalIndex: 0, hidden: false }];
}
export { match, capture };
