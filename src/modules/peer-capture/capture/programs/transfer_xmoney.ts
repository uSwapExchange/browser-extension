// @ts-nocheck
// Bundled public Peer capture program, reviewed 2026-11-09. No runtime code loading.
// Source: https://api.zkp2p.xyz/providers/xmoney/transfer_xmoney.json
// Observed X Money gRPC-Web schema, 2026-10-28. No host or browser APIs.
function requireValue(condition, reason) {
  if (!condition) throw new Error(reason);
}

function base64Bytes(text) {
  requireValue(typeof text === 'string' && text.length <= 2666668 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text), 'Invalid binary evidence');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(text.length / 4 * 3 - padding);
  requireValue(bytes.length <= 2000000, 'Binary evidence exceeds limit');
  let offset = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = alphabet.indexOf(text[i]), b = alphabet.indexOf(text[i + 1]);
    const c = text[i + 2] === '=' ? 0 : alphabet.indexOf(text[i + 2]);
    const d = text[i + 3] === '=' ? 0 : alphabet.indexOf(text[i + 3]);
    bytes[offset++] = a * 4 + (b >> 4);
    if (text[i + 2] !== '=') bytes[offset++] = (b & 15) * 16 + (c >> 2);
    else requireValue((b & 15) === 0, 'Noncanonical binary evidence');
    if (text[i + 3] !== '=') bytes[offset++] = (c & 3) * 64 + d;
    else requireValue((c & 3) === 0, 'Noncanonical binary evidence');
  }
  return bytes;
}

function utf8(bytes) {
  let encoded = '';
  for (const byte of bytes) encoded += '%' + byte.toString(16).padStart(2, '0');
  return decodeURIComponent(encoded);
}

function grpcMessage(text) {
  const bytes = base64Bytes(text);
  let offset = 0, message = null, trailers = false;
  while (offset < bytes.length) {
    requireValue(!trailers && offset + 5 <= bytes.length, 'Invalid gRPC-Web framing');
    const flag = bytes[offset];
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0);
    offset += 5;
    requireValue(offset + length <= bytes.length, 'Truncated gRPC-Web frame');
    const payload = bytes.subarray(offset, offset + length);
    offset += length;
    if (flag === 0) {
      requireValue(message === null, 'Multiple gRPC-Web messages');
      message = payload;
    } else {
      requireValue(flag === 128 && message !== null && offset === bytes.length, 'Unsupported gRPC-Web frame');
      const status = utf8(payload).split('\r\n').filter(line => line.toLowerCase().startsWith('grpc-status:'));
      requireValue(status.length === 1 && status[0].slice(12).trim() === '0', 'gRPC request did not succeed');
      trailers = true;
    }
  }
  requireValue(message !== null && trailers, 'Missing gRPC-Web message or status');
  return message;
}

function fields(bytes) {
  let offset = 0;
  const result = new Map();
  function varint() {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      requireValue(offset < bytes.length, 'Truncated protobuf varint');
      const byte = bytes[offset++];
      requireValue(i < 9 || byte <= 1, 'Protobuf varint overflow');
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) return value;
    }
    throw new Error('Invalid protobuf varint');
  }
  while (offset < bytes.length) {
    const tag = varint();
    const number = Number(tag >> 3n), wire = Number(tag & 7n);
    requireValue(number > 0 && number <= 536870911, 'Invalid protobuf field');
    let value;
    if (wire === 0) value = varint();
    else {
      requireValue(wire === 1 || wire === 2 || wire === 5, 'Unsupported protobuf wire type');
      const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : 4;
      requireValue(Number.isSafeInteger(length) && length <= bytes.length - offset, 'Truncated protobuf field');
      value = bytes.subarray(offset, offset + length);
      offset += length;
    }
    if (!result.has(number)) result.set(number, []);
    result.get(number).push({ wire, value });
  }
  return result;
}

function scalar(message, number, wire) {
  const entries = message.get(number);
  if (entries === undefined) return undefined;
  requireValue(entries.length === 1 && entries[0].wire === wire, 'Duplicate or mistyped protobuf field');
  return entries[0].value;
}

function uint(message, number) {
  const value = scalar(message, number, 0);
  // Proto3 omits zero-valued scalars. This is the schema default, including USD=0.
  return value === undefined ? 0n : value;
}

function messageField(message, number) {
  const value = scalar(message, number, 2);
  requireValue(value !== undefined, 'Missing payment message');
  return fields(value);
}

function stringField(message, number) {
  const value = scalar(message, number, 2);
  requireValue(value !== undefined, 'Missing payment string');
  const text = utf8(value);
  requireValue(text.trim().length > 0 && text.length <= 256, 'Invalid payment string');
  return text;
}

function history(text) {
  const response = fields(grpcMessage(text));
  requireValue(uint(response, 3) === 0n, 'Transaction projection may be stale');
  const entries = response.get(1);
  if (entries === undefined) return [];
  requireValue(entries.length <= 100 && entries.every(entry => entry.wire === 2), 'Invalid history entries');
  const transactions = entries.map(entry => fields(entry.value));
  const ids = transactions.map(transaction => stringField(transaction, 1));
  requireValue(new Set(ids).size === ids.length, 'Duplicate transaction identity');
  return transactions;
}

// TransferStatus (transaction field 7) names from X Money's web client for the statuses
// the attestor accepts. Sender history shows PENDING_RECIPIENT_ONBOARDING as "Awaiting
// access to Money" and PENDING_RECIPIENT_ACTION as "Awaiting acceptance".
const TRANSFER_STATUSES = new Map([
  [2n, 'SETTLED'], [8n, 'PENDING_RECIPIENT_ONBOARDING'], [9n, 'PENDING_RECIPIENT_ACTION'],
]);

// Every outgoing row is offered whatever its status, product or display state; the attestor
// refetches history and accepts only outgoing P2P rows with status 2, 8 or 9.
function payment(transaction) {
  const presentation = messageField(transaction, 34);
  if (uint(presentation, 2) !== 2n) return null;
  const amount = messageField(presentation, 4);
  const micro = uint(amount, 1);
  requireValue(uint(amount, 2) === 0n, 'Currency is not USD');
  requireValue(micro > 0n && micro <= 9223372036854775807n && micro % 10000n === 0n, 'Invalid cent amount');
  const counterparty = messageField(messageField(presentation, 11), 2);
  requireValue(uint(counterparty, 1) > 0n && uint(counterparty, 1) <= 9223372036854775807n, 'Missing counterparty X identity');
  const recipient = stringField(counterparty, 3).toLowerCase();
  const time = messageField(presentation, 1);
  const seconds = uint(time, 1), nanos = uint(time, 2);
  requireValue(seconds > 0n && seconds <= 8640000000000n && nanos <= 999999999n, 'Invalid payment timestamp');
  const timestamp = seconds * 1000n + nanos / 1000000n;
  requireValue(timestamp <= 8640000000000000n, 'Payment timestamp exceeds date range');
  return { amountMinor: (micro / 10000n).toString(), currency: 'USD', recipient,
    paymentId: stringField(transaction, 1), timestampMs: timestamp.toString(),
    transferStatus: TRANSFER_STATUSES.get(uint(transaction, 7)) ?? null, direction: 'outgoing' };
}

function match({ request }) {
  return request.method === 'POST' &&
    request.url === 'https://money.x.com/api/web/orchestrator.service.v1beta1.OrchestratorService/SearchTransactions' &&
    request.body === String.fromCharCode(0, 0, 0, 0, 8, 26, 6, 8, 1, 16, 6, 24, 25);
}
function capture({ event, params }) {
  if (!match({ request: event.request })) return null;
  requireValue(event.response.status === 200 && event.response.bodyEncoding === 'base64', 'Binary capture update required');
  const rows = history(event.response.body).map((transaction, originalIndex) => {
    let result;
    try {
      result = payment(transaction);
    } catch {
      // One row this program cannot decode must not hide the rest of the page.
      return null;
    }
    if (result === null) return null;
    return { originalIndex, hidden: false, params: { PAYMENT_ID: result.paymentId },
      amount: (BigInt(result.amountMinor) * 10000n).toString(), currency: result.currency,
      recipient: result.recipient, paymentId: result.paymentId,
      date: result.timestampMs, direction: 'Debit', transferStatus: result.transferStatus };
  }).filter(row => row !== null);
  if (Object.keys(params).length === 0) return rows;
  requireValue(Object.keys(params).length === 1 && Number.isSafeInteger(params.index) && params.index >= 0, 'Expected one original history index');
  const selected = rows.find(row => row.originalIndex === params.index);
  return selected === undefined ? null : selected.params;
}

export { match, capture };
