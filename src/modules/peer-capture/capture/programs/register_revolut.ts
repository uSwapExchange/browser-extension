// @ts-nocheck
// Bundled public Peer capture program, reviewed 2026-11-09. No runtime code loading.
// Source: https://api.zkp2p.xyz/providers/revolut/register_revolut.json
const CURRENT_USER_URL = "https://app.revolut.com/api/retail/user/current";

function match({ request }) {
  // HEAD polls share this URL but carry no identity body.
  return request.method === "GET" && request.url === CURRENT_USER_URL;
}

function capture({ event, params }) {
  if (!match({ request: event.request })) return null;
  if (event.response.status !== 200 || !event.response.body) return null;
  const user = JSON.parse(event.response.body).user;
  if (typeof user !== "object" || user === null) throw new Error("Revolut current-user response has no user.");
  const revtag = typeof user.username === "string" ? user.username.trim() : "";
  if (!revtag) throw new Error("Create a Revtag in Revolut before verifying.");
  // Display only: the attestor refetches this endpoint with the encrypted session and signs its Revtag.
  return selectResult([{ revtag, params: {}, originalIndex: 0, hidden: false }], params);
}

function selectResult(rows, params) {
  if (Object.keys(params).length === 0) return rows;
  if (Object.keys(params).length !== 1 || !Number.isSafeInteger(params.index) || params.index < 0) {
    throw new Error('Use empty capture params for metadata, or supply { "index": 0 }.');
  }
  const row = rows.find((item) => item.originalIndex === params.index);
  return row ? { ...row.params, index: row.originalIndex } : null;
}
export { match, capture };
