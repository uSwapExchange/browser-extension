import type { ExtractedRow } from '../templates/types.js';

const missing = (value: unknown) => value == null || value === '';

/** Display metadata is a selection aid. The attested transfer remains authoritative. */
export function prepareBuyerRows(
  platform: string,
  rows: ExtractedRow[],
  paramsByIndex: Map<number, Record<string, unknown>>,
): ExtractedRow[] {
  return rows.map((row) => {
    const params = paramsByIndex.get(row.originalIndex) ?? {};
    let hidden = row.hidden;
    // Wise's activity feed can omit visibleOn. Its proof URL instead selects
    // the actual transfer by two identifiers, where the TEE verifies the date.
    // Never manufacture a display date or relax payment-identifying fields.
    if (platform === 'wise' && missing(row.date)) {
      hidden = ['amount', 'paymentId', 'recipient', 'currency'].some((field) => missing(row[field]))
        || !/^\d+$/.test(String(params.PROFILE_ID ?? ''))
        || !/^\d+$/.test(String(params.TRANSACTION_ID ?? ''));
    }
    if (Object.values(params).some(missing)) hidden = true;
    return { ...row, hidden, params };
  });
}

export function unusableRowsMessage(platform: string, rows: ExtractedRow[]): string {
  if (rows.length === 0) {
    return `No ${platform} transactions were returned. Open the account used to pay, open its outgoing transaction history, then retry.`;
  }
  const fields = new Set<string>();
  for (const row of rows) {
    for (const [field, value] of Object.entries(row)) {
      if (!['params', 'hidden', 'originalIndex'].includes(field) && missing(value)) fields.add(field);
    }
    const params = row.params as Record<string, unknown> | undefined;
    for (const [field, value] of Object.entries(params ?? {})) if (missing(value)) fields.add(field);
  }
  const detail = fields.size ? ` Missing fields: ${[...fields].sort().join(', ')}.` : '';
  return `${platform} returned ${rows.length} history item(s), but none contained complete payment details.${detail} Open the outgoing transfer details in the account used to pay, then retry.`;
}
