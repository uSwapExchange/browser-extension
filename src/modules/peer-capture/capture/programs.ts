import * as p0 from './programs/register_venmo.js';
import * as p1 from './programs/register_cashapp.js';
import * as p2 from './programs/register_revolut.js';
import * as p3 from './programs/register_monzo.js';
import * as p4 from './programs/register_chime.js';
import * as p5 from './programs/register_xmoney.js';
import * as p6 from './programs/transfer_xmoney.js';
import type { ProviderTemplate } from '../templates/types.js';

export interface CaptureProgram {
  match(input: { request: { method: string; url: string; body: string }; params: Record<string, unknown> }): boolean;
  capture(input: { event: { request: { method: string; url: string; body: string }; response: { status: number; body: string; bodyEncoding?: string } }; params: Record<string, unknown> }): unknown;
}
const bundled: Record<string, { program: CaptureProgram; digest: string }> = {
  register_venmo: { program: p0, digest: '7b6d307d1408fed1c7132c315bda957e860d5a82c84dfe51a29564ecf82ea126' },
  register_cashapp: { program: p1, digest: 'b801cb205a0faeea96f0e836205bf5ef2a63f4574d6132633acfac97ee13e8a5' },
  register_revolut: { program: p2, digest: 'fd69589554c7c1d5b9a644ff4c4d4f7664fe91e66ad59e2a495f66beda761feb' },
  register_monzo: { program: p3, digest: 'eeb01364d97700c21008e86b04ec9362c6b4a9697c4da71a961f5aae678eeb63' },
  register_chime: { program: p4, digest: 'afe7376f6b0a8d5ce3e2101dc9a6100d1f2eda2cf7f5eff26803de344030020f' },
  register_xmoney: { program: p5, digest: '14d25123b2a1d9720eb073c2913db9dfffcc3658a0bb502481c78452feaba019' },
  transfer_xmoney: { program: p6, digest: 'b54d38da0b2e902bddac2cf524921ee8cce830490f0814d7bf2653899833d7e5' },
};

export function captureProgram(template: ProviderTemplate): CaptureProgram | null {
  if (template.captureJsEnabled !== true) return null;
  const entry = bundled[template.actionType ?? ''];
  if (!entry) throw new Error('This payment method needs a newer extension. Update uSwap and retry.');
  return entry.program;
}

/** Refuse changed provider code until it has been reviewed and bundled. Never eval downloaded scripts. */
export async function verifyCaptureProgram(template: ProviderTemplate): Promise<void> {
  if (!captureProgram(template)) return;
  const bytes = new TextEncoder().encode(String(template.captureJs ?? ''));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== bundled[template.actionType!]!.digest) {
    throw new Error('The provider capture changed. Update the uSwap extension before retrying.');
  }
}
