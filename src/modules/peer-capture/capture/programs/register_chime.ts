// @ts-nocheck
// Bundled public Peer capture program, reviewed 2026-11-09. No runtime code loading.
// Source: https://api.zkp2p.xyz/providers/chime/register_chime.json
const GRAPHQL_URL = "https://app.chime.com/api/graphql";
// The attestor pins the same persisted query; update both together.
const USER_QUERY_HASH = "md5:f4a5ebcc4103cf23f7e582af45b0edd0";

const USER_QUERY_BODY = JSON.stringify({
  operationName: "UserQuery",
  variables: {},
  extensions: { persistedQuery: { version: 1, sha256Hash: USER_QUERY_HASH } },
});

function match({ request }) {
  // Require the web app's exact compact body, including key order and no whitespace.
  // Comparing raw bytes also rejects duplicate keys and extra fields before credentialed replay.
  return request.method === "POST" && request.url === GRAPHQL_URL && request.body === USER_QUERY_BODY;
}

function capture({ event, params }) {
  if (!match({ request: event.request })) return null;
  if (event.response.status !== 200 || !event.response.body) return null;
  const response = JSON.parse(event.response.body);
  if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length > 0)) throw new Error("Chime UserQuery returned errors.");
  const member = response.data && response.data.me;
  if (typeof member !== "object" || member === null) throw new Error("Chime UserQuery response has no member.");
  const username = typeof member.username === "string" ? member.username.trim() : "";
  if (!username || username.includes("$")) throw new Error("Set a $ChimeSign in Chime before verifying.");
  // Display only: the attestor reruns its pinned UserQuery with the encrypted session and signs this ChimeSign.
  return selectResult([{ chimesign: "$" + username.toLowerCase(), params: {}, originalIndex: 0, hidden: false }], params);
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
