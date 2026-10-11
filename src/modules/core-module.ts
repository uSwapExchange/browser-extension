import type { ExtensionModule } from '../core/modules/registry.js';
import { getPrompt, resolvePrompt } from '../core/consent/prompt.js';
import { grantOrigin, listGrants, revokeOrigin } from '../core/storage/origin-grants.js';
import { isFirstPartySender } from '../core/sender.js';

function requireExtensionPage(sender: chrome.runtime.MessageSender): void {
  if (!isFirstPartySender(sender)) throw new Error('This operation is extension-page only');
}

/**
 * Built-in handlers used by the extension's own pages (prompt, options).
 * These handlers are restricted to extension pages. Page relays expose only
 * the Peer contract and reconstruct bus envelopes, preventing a web iframe
 * from borrowing the panel's extension privileges.
 */

interface ResolvePromptPayload {
  promptId?: string;
  approved?: boolean;
}

export const coreModule: ExtensionModule = {
  id: 'core',
  handlers: {
    async getPrompt(payload, sender) {
      requireExtensionPage(sender);
      const { promptId } = (payload ?? {}) as ResolvePromptPayload;
      if (!promptId) throw new Error('promptId required');
      return getPrompt(promptId);
    },

    async resolvePrompt(payload, sender) {
      requireExtensionPage(sender);
      const { promptId, approved } = (payload ?? {}) as ResolvePromptPayload;
      if (!promptId || typeof approved !== 'boolean') throw new Error('promptId and approved required');
      const record = await getPrompt(promptId);
      if (!record) throw new Error('Unknown prompt');
      if (record.kind === 'connect' && approved) {
        await grantOrigin(record.origin);
      }
      await resolvePrompt(promptId, approved);
      return { ok: true };
    },

    async listGrants(_payload, sender) {
      requireExtensionPage(sender);
      return listGrants();
    },

    async revokeGrant(payload, sender) {
      requireExtensionPage(sender);
      const { origin } = (payload ?? {}) as { origin?: string };
      if (!origin) throw new Error('origin required');
      await revokeOrigin(origin);
      return { ok: true };
    },
  },
};
