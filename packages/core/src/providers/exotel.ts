/**
 * Exotel masked calling (ported from backend/api telephony.ts).
 */
import {config} from '../config';
import {logger} from '../logger';
import type {TelephonyProvider} from './types';

const JOB = 'provider:telephony:exotel';

function exotelToken(): string {
  return (config.EXOTEL_API_TOKEN ?? config.EXOTEL_TOKEN ?? '').trim();
}

function creds(): {sid: string; apiKey: string; token: string} {
  const sid = config.EXOTEL_SID?.trim();
  const apiKey = config.EXOTEL_API_KEY?.trim();
  const token = exotelToken();
  if (!sid || !apiKey || !token) {
    throw new Error('Exotel is not configured (EXOTEL_SID / EXOTEL_API_KEY / EXOTEL_API_TOKEN).');
  }
  return {sid, apiKey, token};
}

export const exotelTelephonyProvider: TelephonyProvider = {
  mock: false,

  async placeMaskedCall(input) {
    const {sid, apiKey, token} = creds();
    const url = `https://api.exotel.com/v1/Accounts/${sid}/Calls/connect.json`;
    const body = new URLSearchParams({
      From: input.callerNumber,
      To: input.calleeNumber,
      CallerId: input.virtualNumber.replace(/^\+/, ''),
      ...(input.callbackUrl ? {StatusCallback: input.callbackUrl} : {}),
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
      const text = await res.text();
      logger.warn(JOB, 'connect failed', {status: res.status, detail: text.slice(0, 200)});
      throw new Error('Could not initiate masked call.');
    }

    const data = (await res.json()) as {Call?: {Sid?: string; Status?: string}};
    const providerRef = data?.Call?.Sid;
    if (!providerRef) throw new Error('Invalid Exotel response.');

    const statusRaw = String(data.Call?.Status ?? 'queued').toLowerCase();
    const status =
      statusRaw === 'in-progress' || statusRaw === 'completed'
        ? 'connected'
        : statusRaw === 'failed' || statusRaw === 'busy'
        ? 'failed'
        : statusRaw === 'ringing'
        ? 'ringing'
        : 'placing';

    logger.info(JOB, 'call placed', {providerRef, status});
    return {providerRef, status};
  },

  async endCall(providerRef: string): Promise<void> {
    const {sid, apiKey, token} = creds();
    const url = `https://api.exotel.com/v1/Accounts/${sid}/Calls/${providerRef}.json`;
    const auth = Buffer.from(`${apiKey}:${token}`).toString('base64');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({Status: 'completed'}).toString(),
    });
    if (!res.ok) {
      logger.warn(JOB, 'end call failed', {providerRef, status: res.status});
    }
  },
};
