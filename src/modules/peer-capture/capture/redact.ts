import type { ExtractedRow } from '../templates/types.js';

/**
 * Security invariant enforcement: values derived from private request
 * material (request body / secret headers) must NEVER appear in the metadata
 * rows posted to the page. Metadata is built from response extraction only;
 * this is a defense-in-depth check that asserts no private value leaked.
 */

function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (value.length >= 4) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

export class PrivateMaterialLeak extends Error {
  constructor(public readonly field: string) {
    super(`Private capture material leaked into metadata field "${field}"`);
    this.name = 'PrivateMaterialLeak';
  }
}

/**
 * Throws PrivateMaterialLeak if any private value appears verbatim in a
 * metadata row. `privateValues` are the param values flagged as
 * requestBody-sourced plus any secret-header values.
 */
export function assertNoPrivateLeak(rows: ExtractedRow[], privateValues: unknown[]): void {
  const secrets = new Set<string>();
  for (const value of privateValues) collectStrings(value, secrets);
  if (secrets.size === 0) return;

  for (const row of rows) {
    for (const [field, value] of Object.entries(row)) {
      if (field === 'originalIndex' || field === 'hidden') continue;
      const publicStrings = new Set<string>();
      collectStrings(value, publicStrings);
      for (const publicValue of publicStrings) {
        if ([...secrets].some((secret) => publicValue === secret
          || (secret.length >= 12 && publicValue.includes(secret)))) {
          throw new PrivateMaterialLeak(field);
        }
      }
    }
  }
}


/** Cookie context can contain public account IDs as well as credentials.
 * Wise's hosted template deliberately exports numeric profile/transfer IDs
 * from its response. Do not mistake those exact proof fields for a cookie
 * leak. Raw cookies, secret headers, private selectors and every other field
 * remain subject to the strict check. Inline templates get no exception.
 */
export function assertBuyerMetadataPrivacy(input: {
  rows: ExtractedRow[];
  platform: string;
  inline: boolean;
  headers: Record<string, string>;
  secretHeaders?: string[];
  privateValues: unknown[];
}): void {
  const privateValues = [...input.privateValues];
  const cookieValues: unknown[] = [];
  for (const [name, value] of Object.entries(input.headers)) {
    if (/cookie|authorization|token|csrf|xsrf|api[-_]key/i.test(name)
      || input.secretHeaders?.some((secret) => secret.toLowerCase() === name.toLowerCase())) {
      privateValues.push(value);
      if (/cookie/i.test(name)) {
        for (const part of value.split(';')) {
          const separator = part.indexOf('=');
          if (separator >= 0) cookieValues.push(part.slice(separator + 1).trim());
        }
      }
      if (/authorization/i.test(name)) privateValues.push(value.replace(/^Bearer\s+/i, ''));
    }
  }
  assertNoPrivateLeak(input.rows, privateValues);
  const cookieRows = input.rows.map((row) => {
    if (input.platform !== 'wise' || input.inline) return row;
    const params = { ...(row.params as Record<string, unknown> ?? {}) };
    for (const name of ['PROFILE_ID', 'TRANSACTION_ID']) {
      if (typeof params[name] === 'string' && /^\d+$/.test(params[name] as string)) delete params[name];
    }
    return { ...row, params };
  });
  assertNoPrivateLeak(cookieRows, cookieValues);
}
