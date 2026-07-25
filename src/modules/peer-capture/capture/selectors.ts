import type { ProviderTemplate, TemplateSelector } from '../templates/types.js';
import { JSONPath } from 'jsonpath-plus';
import { offscreenCall } from '../../../core/offscreen/rpc.js';
import { jsonPathWithIndex } from './extract.js';

/**
 * Build the buyer-TEE `params` object from the template's paramNames /
 * paramSelectors for a selected row.
 *
 * Selectors are evaluated with {{INDEX}} bound to the row's originalIndex.
 * `source` routes the evaluation target; it defaults to the response body.
 * A selector sourced from `requestBody` produces PRIVATE session material —
 * such values are flagged so they can never appear in metadata rows.
 */

export interface CaptureSources {
  responseJson: unknown;
  responseText: string;
  requestBody: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  url: string;
}

export interface ParamResult {
  params: Record<string, unknown>;
  /** Names of params whose value derives from private request material. */
  privateParamNames: string[];
  /** Private values are used only for leak detection, never returned publicly. */
  privateValues: unknown[];
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function jsonSource(source: TemplateSelector['source'], sources: CaptureSources): unknown {
  switch (source) {
    case 'requestBody':
      try { return JSON.parse(sources.requestBody); } catch { return sources.requestBody; }
    case 'requestHeaders':
      return sources.requestHeaders;
    case 'responseHeaders':
      return sources.responseHeaders;
    case 'url':
      return { url: sources.url };
    case 'responseBody':
    default:
      return sources.responseJson;
  }
}

function textSource(source: TemplateSelector['source'], sources: CaptureSources): string {
  switch (source) {
    case 'requestBody':
      return sources.requestBody;
    case 'requestHeaders':
      return stringify(sources.requestHeaders);
    case 'responseHeaders':
      return stringify(sources.responseHeaders);
    case 'url':
      return sources.url;
    case 'responseBody':
    default:
      return sources.responseText;
  }
}

async function evalSelector(
  selector: TemplateSelector,
  index: number,
  sources: CaptureSources,
): Promise<unknown> {
  const source = selector.source ?? 'responseBody';
  const resolved = selector.value.replace(/\{\{INDEX\}\}/g, String(index));
  if (selector.type === 'jsonPath') {
    if (source === 'responseBody') {
      return jsonPathWithIndex(sources.responseJson, selector.value, index);
    }
    return JSONPath({
      path: resolved,
      json: jsonSource(source, sources) as object,
      wrap: false,
    });
  }
  if (selector.type === 'regex') {
    const match = new RegExp(resolved).exec(textSource(source, sources));
    return match?.[1] ?? match?.[0] ?? null;
  }
  const result = await offscreenCall<{ value: string | null }>('xpath-value', {
    html: textSource(source, sources),
    expression: resolved,
  });
  return result.value;
}

export async function buildParams(
  template: ProviderTemplate,
  index: number,
  sources: CaptureSources,
): Promise<ParamResult> {
  const params: Record<string, unknown> = {};
  const privateParamNames: string[] = [];
  const privateValues: unknown[] = [];
  const names = template.paramNames ?? [];
  const selectors = template.paramSelectors ?? [];

  for (let i = 0; i < selectors.length; i += 1) {
    const selector = selectors[i];
    const name = names[i] ?? `param_${i}`;
    if (!selector) continue;
    const value = await evalSelector(selector, index, sources);
    if (selector.source === 'requestBody') {
      privateParamNames.push(name);
      privateValues.push(value);
      continue;
    }
    // Provider-template parameters interpolate into request URLs and the
    // Buyer-TEE schemas declare selector-derived identifiers as strings.
    // JSONPath preserves JSON number types (Wise's ownedByProfile/resource.id
    // are numbers), so normalize them here before the proof reaches the
    // attestation service.
    params[name] = value === null || value === undefined ? value : String(value);
  }
  // params.index is platform-specific and must be added by the page when it
  // selects a row. Sending it for single-transfer rails makes the attestation
  // service reject otherwise-valid Wise/PayPal/Monzo captures.
  return { params, privateParamNames, privateValues };
}

/** Interpolate {{PARAM}} placeholders in a string with built param values. */
export function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    const value = params[key];
    return value == null ? whole : String(value);
  });
}
