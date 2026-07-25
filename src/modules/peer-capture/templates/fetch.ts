import { parseProviderTemplate, type ProviderTemplate } from './types.js';

const TEMPLATE_BASE = 'https://api.zkp2p.xyz/providers';
export const REVOLUT_ALL_POCKETS_AUTH_LINK =
  'https://app.revolut.com/home?accountType=all_main_pockets';
export const REVOLUT_SEE_ALL_TRANSACTIONS_XPATH =
  '//*[self::a or self::button or @role="button"]['
  + 'contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "see all")'
  + ' or contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "view all")'
  + ']';

export interface ResolvedTemplate {
  template: ProviderTemplate;
  /** Inline templates require explicit post-extraction approval before delivery. */
  inline: boolean;
}

export function normalizePlatformTemplate(
  platform: string,
  template: ProviderTemplate,
): ProviderTemplate {
  if (platform !== 'revolut') return template;
  return {
    ...template,
    authLink: REVOLUT_ALL_POCKETS_AUTH_LINK,
    metadata: {
      ...template.metadata,
      // Revolut's authenticated SPA adds request-specific auth context to the
      // transaction-history call. A bare extension fetch gets HTTP 401 even
      // while the user is signed in. Prompt the user to make Revolut issue the
      // request itself, then capture/replay that genuine request exactly as
      // Peer's reference extension expects.
      userInput: template.metadata.userInput ?? {
        promptText:
          'Click “See all” beside Transactions so uSwap can securely verify your payment.',
        transactionXpath: REVOLUT_SEE_ALL_TRANSACTIONS_XPATH,
        waitForXpathMs: 20_000,
        pollIntervalMs: 250,
      },
    },
  };
}

/**
 * Resolve a provider template: inline providerConfig (untrusted, must be
 * approved) takes precedence; otherwise fetch the platform/actionType JSON.
 */
export async function resolveTemplate(input: {
  platform: string;
  actionType: string;
  providerConfig?: unknown;
}): Promise<ResolvedTemplate> {
  if (input.providerConfig != null) {
    return {
      template: normalizePlatformTemplate(
        input.platform,
        parseProviderTemplate(input.providerConfig),
      ),
      inline: true,
    };
  }
  const url = `${TEMPLATE_BASE}/${encodeURIComponent(input.platform)}/${encodeURIComponent(input.actionType)}.json`;
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) {
    throw new Error(`Failed to load template ${input.platform}/${input.actionType}: HTTP ${response.status}`);
  }
  const json: unknown = await response.json();
  return {
    template: normalizePlatformTemplate(
      input.platform,
      parseProviderTemplate(json),
    ),
    inline: false,
  };
}
