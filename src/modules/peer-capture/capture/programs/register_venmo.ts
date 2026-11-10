// @ts-nocheck
// Bundled public Peer capture program, reviewed 2026-11-09. No runtime code loading.
// Source: https://api.zkp2p.xyz/providers/venmo/register_venmo.json
function match({ request, params }) {
  return request.method === 'GET' && /^https:\/\/account\.venmo\.com\/api\/stories\?/.test(request.url) && /[?&]feedType=me(?:&|$)/.test(request.url);
}

function capture({ event, params }) {
  if (event.request.method !== 'GET' || !/^https:\/\/account\.venmo\.com\/api\/stories\?/.test(event.request.url)) return null;
  if (!/[?&]feedType=me(?:&|$)/.test(event.request.url) || event.response.status !== 200 || !event.response.body) return null;
  const sender = event.request.url.match(/[?&]externalId=([^&#]+)/);
  if (!sender || !Array.isArray(JSON.parse(event.response.body).stories)) return null;
  const senderId = decodeURIComponent(sender[1]);
  return selectResult([{ accountId: senderId, params: { SENDER_ID: senderId }, originalIndex: 0, hidden: false }], params);
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
