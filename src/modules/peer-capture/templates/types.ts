import { z } from 'zod';

/**
 * Provider template schema — models the real shape served from
 * https://api.zkp2p.xyz/providers/{platform}/{actionType}.json (verified
 * against venmo/transfer_venmo and cashapp/transfer_cashapp). Permissive on
 * unknown keys: Peer adds fields (mobile, responseMatches, …) the capture
 * engine ignores.
 */

const SelectorSchema = z.object({
  type: z.enum(['jsonPath', 'regex', 'xPath']),
  /** JSONPath / regex pattern; may contain {{INDEX}}. */
  value: z.string(),
  /** Where to evaluate: defaults to the response body. requestBody is private. */
  source: z.enum([
    'responseBody',
    'requestBody',
    'requestHeaders',
    'responseHeaders',
    'url',
  ]).optional(),
}).passthrough();
export type TemplateSelector = z.infer<typeof SelectorSchema>;

const TransactionsExtractionSchema = z.object({
  transactionJsonPathListSelector: z.string().optional(),
  transactionJsonPathSelectors: z.record(z.string(), z.string()).optional(),
  transactionXPathListSelector: z.string().optional(),
  transactionXPathSelectors: z.record(z.string(), z.string()).optional(),
}).passthrough();

const UserInputSchema = z.object({
  promptText: z.string().optional(),
  transactionXpath: z.string(),
  waitForXpathMs: z.number().nonnegative().optional(),
  pollIntervalMs: z.number().nonnegative().optional(),
}).passthrough();

const MetadataSchema = z.object({
  platform: z.string(),
  urlRegex: z.string(),
  method: z.string().optional(),
  /** Some providers (notably Revolut) only return authenticated JSON in-page. */
  shouldReplayRequestInPage: z.boolean().optional(),
  bodyRegex: z.string().optional(),
  fallbackUrlRegex: z.string().optional(),
  fallbackMethod: z.string().optional(),
  fallbackBodyRegex: z.string().optional(),
  metadataUrl: z.string().optional(),
  metadataUrlMethod: z.string().optional(),
  metadataUrlBody: z.string().optional(),
  preprocessRegex: z.string().optional(),
  shouldSkipCloseTab: z.boolean().optional(),
  userInput: UserInputSchema.optional(),
  transactionsExtraction: TransactionsExtractionSchema.optional(),
}).passthrough();

export const ProviderTemplateSchema = z.object({
  actionType: z.string().optional(),
  platform: z.string().optional(),
  authLink: z.string().url(),
  /** Canonical request shape (may contain {{PARAM}} placeholders). */
  url: z.string(),
  method: z.string().default('GET'),
  body: z.string().optional().default(''),
  metadata: MetadataSchema,
  paramNames: z.array(z.string()).optional().default([]),
  paramSelectors: z.array(SelectorSchema).optional().default([]),
  secretHeaders: z.array(z.string()).optional().default([]),
}).passthrough();

export type ProviderTemplate = z.infer<typeof ProviderTemplateSchema>;

export function parseProviderTemplate(value: unknown): ProviderTemplate {
  return ProviderTemplateSchema.parse(value);
}

/** A metadata row exposed to the page, keyed by template selector names. */
export interface ExtractedRow {
  [field: string]: unknown;
  originalIndex: number;
  hidden?: boolean;
}
