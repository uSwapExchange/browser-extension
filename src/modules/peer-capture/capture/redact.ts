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
