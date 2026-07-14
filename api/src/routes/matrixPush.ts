/**
 * Matrix Push Gateway — Synapse → FCM for TrustRoute.
 *
 * Implements POST /_matrix/push/v1/notify (Matrix Push Gateway API) using the
 * existing Firebase Admin SDK. Clients register an HTTP pusher whose `data.url`
 * points here; Synapse forwards notifications.
 */
import { Router, Request, Response, NextFunction } from 'express';
import admin from 'firebase-admin';
import { logger } from '../utils/logger';

export const matrixPushRouter = Router();

type PushDevice = {
  app_id: string;
  pushkey: string;
  pushkey_ts?: number;
  data?: Record<string, unknown>;
  tweaks?: Record<string, unknown>;
};

type PushNotification = {
  event_id?: string;
  room_id?: string;
  type?: string;
  sender?: string;
  sender_display_name?: string;
  room_name?: string;
  room_alias?: string;
  content?: { body?: string; msgtype?: string };
  counts?: { unread?: number; missed_calls?: number };
  devices: PushDevice[];
  prio?: string;
};

function getMessaging(): admin.messaging.Messaging | null {
  try {
    if (!admin.apps.length) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!raw) return null;
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(raw)),
        databaseURL: process.env.FIREBASE_DATABASE_URL,
      });
    }
    return admin.messaging();
  } catch (err: any) {
    logger.warn('matrixPush', `Firebase init failed: ${err?.message}`);
    return null;
  }
}

function previewFrom(n: PushNotification): { title: string; body: string } {
  const title = n.room_name
    || n.sender_display_name
    || n.sender
    || 'TrustRoute';
  const body = (n.content?.body && String(n.content.body).trim())
    || (n.type === 'm.room.encrypted' ? 'New encrypted message' : 'New message');
  return { title: title.slice(0, 80), body: body.slice(0, 180) };
}

matrixPushRouter.post('/notify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notification = (req.body?.notification ?? {}) as PushNotification;
    const devices = Array.isArray(notification.devices) ? notification.devices : [];
    if (!devices.length) {
      res.json({ rejected: [] });
      return;
    }

    const messaging = getMessaging();
    if (!messaging) {
      logger.warn('matrixPush', 'Firebase not configured — rejecting all pushkeys');
      res.json({ rejected: devices.map((d) => d.pushkey) });
      return;
    }

    const { title, body } = previewFrom(notification);
    const rejected: string[] = [];

    await Promise.all(devices.map(async (device) => {
      if (!device.pushkey || !device.app_id) {
        if (device.pushkey) rejected.push(device.pushkey);
        return;
      }
      try {
        await messaging.send({
          token: device.pushkey,
          notification: { title, body },
          data: {
            type: 'matrix_message',
            event_id: notification.event_id ?? '',
            room_id: notification.room_id ?? '',
            sender: notification.sender ?? '',
            sender_name: notification.sender_display_name ?? '',
            room_name: notification.room_name ?? '',
            unread: String(notification.counts?.unread ?? ''),
            event_type: notification.type ?? '',
          },
          android: {
            priority: notification.prio === 'low' ? 'normal' : 'high',
            notification: {
              channelId: 'messages',
              tag: notification.room_id ?? notification.event_id ?? 'matrix',
            },
          },
          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: notification.counts?.unread,
                threadId: notification.room_id,
              },
            },
          },
        });
      } catch (err: any) {
        const code = err?.code ?? err?.errorInfo?.code ?? '';
        logger.warn('matrixPush', `FCM failed for ${device.app_id}: ${err?.message} (${code})`);
        // Only reject permanently-invalid tokens so Synapse drops the pusher.
        if (
          code.includes('registration-token-not-registered')
          || code.includes('invalid-registration-token')
          || code.includes('messaging/registration-token-not-registered')
          || code.includes('messaging/invalid-registration-token')
        ) {
          rejected.push(device.pushkey);
        }
      }
    }));

    res.json({ rejected });
  } catch (err) {
    next(err);
  }
});
