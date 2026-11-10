// @ts-nocheck
// Bundled public Peer capture program, reviewed 2026-11-09. No runtime code loading.
// Source: https://api.zkp2p.xyz/providers/xmoney/register_xmoney.json
// X Money's own GetCustomer request from its web client (2026-11-06); the empty request asks for the session's
// customer. The attestor replays it with the encrypted session, requires send permission and signs the customer's
// X handle. This program forwards nothing from the response.
const CUSTOMER_URL = 'https://money.x.com/api/web/orchestrator.service.v1beta1.OrchestratorService/GetCustomer';

function match({ request }) {
  return request.method === 'POST' && request.url === CUSTOMER_URL && request.body === String.fromCharCode(0, 0, 0, 0, 0);
}

function capture({ event, params }) {
  // Keep listening through failed or signed-out requests.
  if (!match({ request: event.request }) || event.response.status !== 200) return null;
  if (!event.response.body) return null;
  if (event.response.bodyEncoding !== 'base64') throw new Error('Binary capture update required');
  const text = event.response.body;
  // Like transfer_xmoney, require a complete unary gRPC-Web response and a successful trailer.
  if (typeof text !== 'string' || text.length === 0 || text.length > 2666668 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(text.length / 4 * 3 - padding);
  if (bytes.length > 2000000) return null;
  let offset = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = alphabet.indexOf(text[i]), b = alphabet.indexOf(text[i + 1]);
    const c = text[i + 2] === '=' ? 0 : alphabet.indexOf(text[i + 2]);
    const d = text[i + 3] === '=' ? 0 : alphabet.indexOf(text[i + 3]);
    bytes[offset++] = a * 4 + (b >> 4);
    if (text[i + 2] !== '=') bytes[offset++] = (b & 15) * 16 + (c >> 2);
    else if ((b & 15) !== 0) return null;
    if (text[i + 3] !== '=') bytes[offset++] = (c & 3) * 64 + d;
    else if ((c & 3) !== 0) return null;
  }
  offset = 0;
  let hasMessage = false, hasTrailer = false;
  while (offset < bytes.length) {
    if (offset + 5 > bytes.length) return null;
    const flag = bytes[offset];
    const length = new DataView(bytes.buffer, offset + 1, 4).getUint32(0);
    offset += 5;
    if (offset + length > bytes.length) return null;
    const payload = bytes.subarray(offset, offset + length);
    offset += length;
    if (flag === 0) {
      if (hasMessage || length === 0) return null;
      hasMessage = true;
    } else {
      if (flag !== 128 || !hasMessage || offset !== bytes.length) return null;
      let trailer = '';
      for (const byte of payload) trailer += String.fromCharCode(byte);
      const statuses = trailer.split('\r\n').filter(line => line.toLowerCase().startsWith('grpc-status:'));
      if (statuses.length !== 1 || statuses[0].slice(12).trim() !== '0') return null;
      hasTrailer = true;
    }
  }
  if (!hasTrailer) return null;
  if (Object.keys(params).length === 0) return [{ capture: 'xmoney', params: {}, originalIndex: 0, hidden: false }];
  if (Object.keys(params).length !== 1 || params.index !== 0) {
    throw new Error('Use empty capture params for metadata, or supply { "index": 0 }.');
  }
  return { index: 0 };
}

export { match, capture };
