import { parseProviderTemplate, type ProviderTemplate } from './types.js';

const TEMPLATE_BASE = 'https://api.zkp2p.xyz/providers';
export const REVOLUT_ALL_POCKETS_AUTH_LINK =
  'https://app.revolut.com/home?accountType=all_main_pockets';

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
