import { JSONPath } from 'jsonpath-plus';
import { offscreenCall } from '../../../core/offscreen/rpc.js';
import type { ExtractedRow, ProviderTemplate } from '../templates/types.js';

/**
 * Pure JSON metadata extraction. HTML/XPath templates are extracted in the
 * offscreen document (the service worker has no DOMParser) and are not
 * handled here.
 */

function jsonQuery(json: unknown, path: string): unknown {
  const result = JSONPath({ path, json: json as object, wrap: false });
  return result;
}

function missing(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function rowFromJson(
  item: unknown,
  originalIndex: number,
  selectors: Record<string, string>,
): ExtractedRow {
  const row: ExtractedRow = { originalIndex };
  for (const [field, selector] of Object.entries(selectors)) {
    row[field] = jsonQuery(item, selector);
  }
  row.hidden = Object.entries(row)
    .filter(([field]) => field !== 'originalIndex' && field !== 'hidden')
    .some(([, value]) => missing(value));
  return row;
}

/**
 * Run the template's transactionsExtraction selectors over a parsed JSON
 * response. Each row keeps its originalIndex in the platform's raw list —
 * index-requiring platforms (venmo/cashapp/revolut/zelle) need it to build
 * per-row params.
 */
export function extractJsonRows(template: ProviderTemplate, responseJson: unknown): ExtractedRow[] {
  const extraction = template.metadata.transactionsExtraction;
  const listSelector = extraction?.transactionJsonPathListSelector;
  const fieldSelectors = extraction?.transactionJsonPathSelectors;
  if (!fieldSelectors) return [];

  // An omitted/empty list selector means the selectors target one root object
  // (used by Chime's per-transaction GraphQL response).
  if (!listSelector) return [rowFromJson(responseJson, 0, fieldSelectors)];

  const list = jsonQuery(responseJson, listSelector);
  if (!Array.isArray(list)) return [];

  return list.map((item, originalIndex) => rowFromJson(item, originalIndex, fieldSelectors));
}

/** Evaluate a JSONPath against the full response body with {{INDEX}} bound. */
export function jsonPathWithIndex(json: unknown, path: string, index: number): unknown {
  const resolved = path.replace(/\{\{INDEX\}\}/g, String(index));
  return jsonQuery(json, resolved);
}

/** Parse JSON, including Peer templates that wrap it in HTML or encode it twice. */
export function parseReplayPayload(
  rawText: string,
  preprocessRegex?: string,
): { text: string; json: unknown } {
  let text = rawText;
  if (preprocessRegex) {
    const match = new RegExp(preprocessRegex).exec(text);
    if (!match?.[1]) {
      throw new Error('Provider response did not match preprocessRegex');
    }
    text = match[1];
  }

  const parse = (value: string): unknown => {
    try { return JSON.parse(value); } catch { return null; }
  };
  let json = parse(text);
  if (typeof json === 'string') json = parse(json);
  if (json === null && text.includes('\\"')) json = parse(text.replace(/\\"/g, '"'));
  return { text, json };
}

/** Extract either JSONPath or XPath metadata according to the template. */
export async function extractRows(
  template: ProviderTemplate,
  responseText: string,
  responseJson: unknown,
): Promise<ExtractedRow[]> {
  const extraction = template.metadata.transactionsExtraction;
  if (!extraction) return [];

  if (
    extraction.transactionXPathListSelector
    || extraction.transactionXPathSelectors
  ) {
    const result = await offscreenCall<{ rows: ExtractedRow[] }>('xpath-extract', {
      html: responseText,
      listSelector: extraction.transactionXPathListSelector ?? '',
      fieldSelectors: extraction.transactionXPathSelectors ?? {},
    });
    return result.rows;
  }

  if (responseJson === null || responseJson === undefined) {
    throw new Error('Provider response was not valid JSON');
  }
  return extractJsonRows(template, responseJson);
}
