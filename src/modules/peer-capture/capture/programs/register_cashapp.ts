// @ts-nocheck
// Bundled public Peer capture program, reviewed 2026-11-09. No runtime code loading.
// Source: https://api.zkp2p.xyz/providers/cashapp/register_cashapp.json
function match({ request, params }) {
  if (request.method !== 'POST' || request.url !== 'https://cash.app/cash-app/activity/v1.0/page' || !request.body) return false;
  try {
    const payload = JSON.parse(request.body);
    return payload.activity_token?.activity_token_type === 'CUSTOMER_TOKEN' && payload.activity_scope === 'MY_ACTIVITY_WEB_V2' &&
      !!payload.request_context && Object.keys(payload.request_context).length === 0;
  } catch { return false; }
}

function capture({ event, params }) {
  if (event.request.method !== 'POST' || event.request.url !== 'https://cash.app/cash-app/activity/v1.0/page') return null;
  if (event.response.status !== 200 || !event.response.body || !event.request.body) return null;
  const request = JSON.parse(event.request.body);
  if (request.activity_token?.activity_token_type !== 'CUSTOMER_TOKEN' || request.activity_scope !== 'MY_ACTIVITY_WEB_V2') return null;
  if (!request.request_context || Object.keys(request.request_context).length !== 0) return null;
  if (!Array.isArray(JSON.parse(event.response.body).activity_rows)) return null;
  return selectResult([{ capture: 'cashapp', params: {}, originalIndex: 0, hidden: false }], params);
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
