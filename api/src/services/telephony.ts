import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler';

export interface TelephonyBridgeResult {
  provider_ref: string;
  virtual_number: string;
  status: 'placing';
}

export interface TelephonyWebhookEvent {
  provider_ref: string;
  event: 'leg_a_ringing' | 'leg_a_answered' | 'leg_b_ringing' | 'connected' | 'ended' | 'failed';
  billed_seconds?: number;
  failure_reason?: string;
}

export interface TelephonyProvider {
  name: string;
  initiateBridge(params: {
    callerPhone: string;
    calleePhone: string;
    virtualNumber: string;
    callbackUrl: string;
  }): Promise<TelephonyBridgeResult>;
  sendDtmf?(providerRef: string, digits: string): Promise<void>;
  parseWebhook(body: unknown, signature?: string): TelephonyWebhookEvent | null;
}

/** Dev/staging provider — simulates two-legged bridge via delayed webhooks. */
class MockTelephonyProvider implements TelephonyProvider {
  name = 'mock';

  async initiateBridge(params: {
    callerPhone: string;
    calleePhone: string;
    virtualNumber: string;
    callbackUrl: string;
  }): Promise<TelephonyBridgeResult> {
    const providerRef = `mock_${crypto.randomUUID().slice(0, 8)}`;
    // Fire simulated webhook sequence asynchronously (best-effort in dev)
    void this.simulateCall(params.callbackUrl, providerRef);
    return {
      provider_ref: providerRef,
      virtual_number: params.virtualNumber,
      status: 'placing',
    };
  }

  private async simulateCall(callbackUrl: string, providerRef: string) {
    const post = async (event: TelephonyWebhookEvent['event'], billed_seconds?: number) => {
      try {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-telephony-provider': 'mock',
            'x-telephony-signature': 'mock-dev',
          },
          body: JSON.stringify({ provider_ref: providerRef, event, billed_seconds }),
        });
      } catch { /* dev only */ }
    };
    await new Promise((r) => setTimeout(r, 800));
    await post('leg_a_ringing');
    await new Promise((r) => setTimeout(r, 1200));
    await post('leg_a_answered');
    await new Promise((r) => setTimeout(r, 800));
    await post('leg_b_ringing');
    await new Promise((r) => setTimeout(r, 1500));
    await post('connected');
    await new Promise((r) => setTimeout(r, 5000));
    await post('ended', 45);
  }

  parseWebhook(body: unknown): TelephonyWebhookEvent | null {
    const b = body as { provider_ref?: string; event?: string; billed_seconds?: number };
    if (!b?.provider_ref || !b?.event) return null;
    return {
      provider_ref: b.provider_ref,
      event: b.event as TelephonyWebhookEvent['event'],
      billed_seconds: b.billed_seconds,
    };
  }

  async sendDtmf(_providerRef: string, _digits: string): Promise<void> {
    /* mock — no-op in dev */
  }
}

/** Exotel click-to-call adapter (when credentials present). */
class ExotelTelephonyProvider implements TelephonyProvider {
  name = 'exotel';

  async initiateBridge(params: {
    callerPhone: string;
    calleePhone: string;
    virtualNumber: string;
    callbackUrl: string;
  }): Promise<TelephonyBridgeResult> {
    const sid = process.env.EXOTEL_SID;
    const token = process.env.EXOTEL_TOKEN;
    const apiKey = process.env.EXOTEL_API_KEY;
    if (!sid || !token || !apiKey) {
      throw new AppError(503, 'TELEPHONY_UNAVAILABLE', 'Telephony provider not configured.');
    }

    const url = `https://api.exotel.com/v1/Accounts/${sid}/Calls/connect.json`;
    const body = new URLSearchParams({
      From: params.callerPhone,
      To: params.calleePhone,
      CallerId: params.virtualNumber.replace('+', ''),
      StatusCallback: params.callbackUrl,
    });

    const auth = Buffer.from(`${apiKey}:${token}`).toString('base64');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new AppError(502, 'TELEPHONY_ERROR', 'Could not initiate masked call.');
    }

    const data = await res.json() as { Call?: { Sid?: string } };
    const providerRef = data?.Call?.Sid;
    if (!providerRef) {
      throw new AppError(502, 'TELEPHONY_ERROR', 'Invalid telephony response.');
    }

    return {
      provider_ref: providerRef,
      virtual_number: params.virtualNumber,
      status: 'placing',
    };
  }

  parseWebhook(body: unknown): TelephonyWebhookEvent | null {
    const b = body as Record<string, string>;
    const ref = b.CallSid ?? b.Sid;
    const status = (b.Status ?? b.CallStatus ?? '').toLowerCase();
    if (!ref) return null;

    const map: Record<string, TelephonyWebhookEvent['event']> = {
      queued: 'placing' as TelephonyWebhookEvent['event'],
      ringing: 'leg_b_ringing',
      'in-progress': 'connected',
      completed: 'ended',
      busy: 'failed',
      'no-answer': 'failed',
      failed: 'failed',
    };
    const event = map[status];
    if (!event) return null;

    const billed = b.DialCallDuration ? parseInt(b.DialCallDuration, 10) : undefined;
    return { provider_ref: ref, event, billed_seconds: billed };
  }

  async sendDtmf(providerRef: string, digits: string): Promise<void> {
    const sid = process.env.EXOTEL_SID;
    const token = process.env.EXOTEL_TOKEN;
    const apiKey = process.env.EXOTEL_API_KEY;
    if (!sid || !token || !apiKey) {
      throw new AppError(503, 'TELEPHONY_UNAVAILABLE', 'Telephony provider not configured.');
    }
    const url = `https://api.exotel.com/v1/Accounts/${sid}/Calls/${providerRef}.json`;
    const body = new URLSearchParams({ Digits: digits });
    const auth = Buffer.from(`${apiKey}:${token}`).toString('base64');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new AppError(502, 'TELEPHONY_ERROR', 'Could not send keypad tone.');
    }
  }
}

let _provider: TelephonyProvider | null = null;

export function getTelephonyProvider(): TelephonyProvider {
  if (_provider) return _provider;
  const name = (process.env.TELEPHONY_PROVIDER ?? '').toLowerCase();
  if (name === 'exotel') {
    _provider = new ExotelTelephonyProvider();
    return _provider;
  }
  if (name === 'mock' || process.env.NODE_ENV !== 'production') {
    _provider = new MockTelephonyProvider();
    return _provider;
  }
  throw new AppError(
    503,
    'TELEPHONY_UNAVAILABLE',
    'Masked calling is briefly unavailable. Set TELEPHONY_PROVIDER=exotel in production.',
  );
}

export function verifyTelephonyWebhook(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const provider = (process.env.TELEPHONY_PROVIDER ?? '').toLowerCase();
  if (provider === 'mock' || (!provider && process.env.NODE_ENV !== 'production')) {
    return req.headers['x-telephony-signature'] === 'mock-dev';
  }
  const secret = process.env.TELEPHONY_WEBHOOK_SECRET;
  if (!secret) return false;
  const sig = req.headers['x-telephony-signature'];
  return typeof sig === 'string' && sig === secret;
}
