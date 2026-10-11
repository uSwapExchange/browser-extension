import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { busCall } from '../core/bus/client.js';
import type { PromptRecord } from '../core/consent/prompt.js';

/**
 * Consent prompt window. Routes (via location.hash):
 *   #/connect?promptId=…           per-origin connection approval
 *   #/inline-template?promptId=…   inline providerConfig post-extraction approval
 *   #/platform-permission?promptId=… optional host-permission grant
 */

function useHashRoute(): { kind: string; promptId: string | null } {
  return useMemo(() => {
    const hash = window.location.hash.replace(/^#\//, '');
    const [kind, query] = hash.split('?');
    const promptId = new URLSearchParams(query ?? '').get('promptId');
    return { kind: kind ?? '', promptId };
  }, []);
}

const panel: React.CSSProperties = {
  margin: '24px 20px',
  padding: '24px 20px',
  borderRadius: 16,
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.09)',
  backdropFilter: 'blur(14px)',
};

const buttonBase: React.CSSProperties = {
  flex: 1,
  padding: '12px 0',
  borderRadius: 12,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  border: '1px solid rgba(255,255,255,0.12)',
};

function Prompt(): React.ReactElement {
  const { kind, promptId } = useHashRoute();
  const [record, setRecord] = useState<PromptRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!promptId) {
      setError('Missing prompt id');
      return;
    }
    busCall<PromptRecord | null>('core', 'getPrompt', { promptId })
      .then((value) => {
        if (!value) setError('This request has expired.');
        else setRecord(value);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [promptId]);

  const decide = async (approved: boolean) => {
    if (!promptId) return;
    try {
      // Platform-permission grants must call chrome.permissions.request from
      // this page's user gesture before the SW records the decision.
      if (approved && kind === 'platform-permission' && record) {
        const patterns = (record.detail as { patterns?: string[] } | undefined)?.patterns ?? [];
        const granted = await chrome.permissions.request({ origins: patterns });
        if (!granted) {
          await busCall('core', 'resolvePrompt', { promptId, approved: false });
          return;
        }
      }
      await busCall('core', 'resolvePrompt', { promptId, approved });
    } finally {
      window.close();
    }
  };

  if (error) {
    return (
      <div style={panel}>
        <p style={{ opacity: 0.7, fontSize: 14 }}>{error}</p>
      </div>
    );
  }
  if (!record) {
    return <div style={{ ...panel, opacity: 0.6, fontSize: 14 }}>Loading…</div>;
  }

  const detail = (record.detail ?? {}) as Record<string, unknown>;
  let title = 'Approval required';
  let body = 'Review the request details before continuing.';
  let confirmLabel = 'Approve';
  if (kind === 'connect') {
    title = 'Connect to uSwap extension';
    body = 'This site wants to use the uSwap extension for payment capture. It will be able to start capture flows and receive encrypted payment proofs.';
    confirmLabel = 'Connect';
  } else if (kind === 'platform-permission') {
    title = `Enable ${String(detail.platform ?? 'platform')} capture`;
    body = `uSwap needs access to ${(detail.patterns as string[] | undefined)?.join(', ') ?? 'this platform'} to capture your payment confirmation. Your login session never leaves the extension.`;
    confirmLabel = 'Allow';
  } else if (kind === 'inline-template') {
    title = 'Approve custom capture';
    body = detail.beforeCapture
      ? `This site provided a custom capture template for ${String(detail.platform)}. Approve reading its payment history and sharing payment details and an encrypted proof with this site. Your login session remains inside the extension.`
      : `This site provided a custom capture template for ${String(detail.platform ?? 'a platform')} (${String(detail.actionType ?? '')}). ${String(detail.rows ?? 0)} transaction(s) were found. Approve to share the encrypted proof.`;
    confirmLabel = 'Approve';
  }

  return (
    <div style={panel}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <img src="/icons/48.png" width={28} height={28} alt="" />
        <strong style={{ fontSize: 16 }}>{title}</strong>
      </div>
      <div
        style={{
          padding: '10px 12px',
          borderRadius: 10,
          background: 'rgba(255,255,255,0.06)',
          fontFamily: 'ui-monospace, monospace',
          fontSize: 13,
          marginBottom: 14,
          wordBreak: 'break-all',
        }}
      >
        {record.origin}
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.5, opacity: 0.75, marginBottom: 22 }}>{body}</p>
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          type="button"
          onClick={() => void decide(false)}
          style={{ ...buttonBase, background: 'transparent', color: '#f4f6fb' }}
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => void decide(true)}
          style={{ ...buttonBase, background: '#f4f6fb', color: '#0b0d12', border: 'none' }}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Prompt />);
