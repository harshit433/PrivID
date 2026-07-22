/**
 * Firebase Cloud Messaging + Realtime Database (ported from backend/api fcm.ts).
 */
import admin from 'firebase-admin';
import {config} from '../config';
import {logger} from '../logger';
import type {PushProvider} from './types';

const JOB = 'provider:firebase';

let initialised = false;

function getApp(): admin.app.App | null {
  if (initialised) return admin.apps[0] ?? null;

  const raw = config.FIREBASE_SERVICE_ACCOUNT_JSON;
  const dbUrl = config.FIREBASE_DATABASE_URL;

  if (!raw) {
    logger.warn(JOB, 'FIREBASE_SERVICE_ACCOUNT_JSON not set');
    initialised = true;
    return null;
  }

  try {
    const serviceAccount = JSON.parse(raw) as admin.ServiceAccount;
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: dbUrl,
      });
    }
    initialised = true;
    logger.info(JOB, 'Firebase Admin initialised');
    return admin.apps[0] ?? null;
  } catch (err) {
    logger.error(JOB, 'Firebase init failed', {error: String((err as Error).message)});
    initialised = true;
    return null;
  }
}

function messaging(): admin.messaging.Messaging | null {
  const app = getApp();
  if (!app) return null;
  try {
    return admin.messaging(app);
  } catch {
    return null;
  }
}

function database(): admin.database.Database | null {
  const app = getApp();
  if (!app || !config.FIREBASE_DATABASE_URL) return null;
  try {
    return admin.database(app);
  } catch {
    return null;
  }
}

export const firebasePushProvider: PushProvider = {
  configured: true,

  async sendData(token: string, data: Record<string, string>): Promise<void> {
    const msg = messaging();
    if (!msg) return;
    await msg.send({
      token,
      data,
      android: {priority: 'high'},
    });
  },

  async sendNotification(
    token: string,
    notification: {title: string; body: string},
    data?: Record<string, string>,
    channelId?: string,
  ): Promise<void> {
    const msg = messaging();
    if (!msg) return;
    try {
      await msg.send({
        token,
        notification,
        data: data ?? {},
        android: {
          priority: 'high',
          ...(channelId ? {notification: {channelId}} : {}),
        },
        apns: {payload: {aps: {sound: 'default'}}},
      });
    } catch (err) {
      const code = (err as {errorInfo?: {code?: string}})?.errorInfo?.code ?? '';
      logger.warn(JOB, 'push failed', {code, detail: String((err as Error).message).slice(0, 120)});
      throw err;
    }
  },

  async rtdbSet(path: string, value: unknown): Promise<void> {
    const db = database();
    if (!db) return;
    await db.ref(path).set(value);
  },
};
