/**
 * Shared FCM helpers for consumer API, business-api, and worker.
 */
import admin from 'firebase-admin';

let _initialised = false;

function getMessaging(): admin.messaging.Messaging | null {
  if (_initialised) {
    return admin.apps.length > 0 ? admin.messaging() : null;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    _initialised = true;
    return null;
  }
  try {
    if (admin.apps.length === 0) {
      const serviceAccount = JSON.parse(raw);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL,
      });
    }
  } catch {
    _initialised = true;
    return null;
  }
  _initialised = true;
  return admin.messaging();
}

export async function sendBusinessSubscriptionRequestPush(
  fcmToken: string,
  payload: {
    subscription_id: string;
    business_id: string;
    business_name: string;
    channel_id: string;
    channel_name: string;
    is_verified: boolean;
  },
): Promise<boolean> {
  const messaging = getMessaging();
  if (!messaging) return false;
  try {
    await messaging.send({
      token: fcmToken,
      notification: {
        title: payload.business_name,
        body: `Wants to send you updates on "${payload.channel_name}"`,
      },
      data: {
        type: 'business_subscription_request',
        subscription_id: payload.subscription_id,
        business_id: payload.business_id,
        business_name: payload.business_name,
        channel_id: payload.channel_id,
        channel_name: payload.channel_name,
        is_verified: payload.is_verified ? 'true' : 'false',
      },
      android: { priority: 'high', notification: { channelId: 'business_updates' } },
    });
    return true;
  } catch {
    return false;
  }
}

export async function sendBusinessMessagePush(
  fcmToken: string,
  payload: {
    message_id: string;
    business_id: string;
    business_name: string;
    channel_id: string;
    content: string;
    is_verified: boolean;
  },
): Promise<boolean> {
  const messaging = getMessaging();
  if (!messaging) return false;
  const preview = payload.content.length > 120 ? `${payload.content.slice(0, 117)}…` : payload.content;
  try {
    await messaging.send({
      token: fcmToken,
      notification: {
        title: payload.business_name,
        body: preview,
      },
      data: {
        type: 'business_message',
        message_id: payload.message_id,
        business_id: payload.business_id,
        business_name: payload.business_name,
        channel_id: payload.channel_id,
        content: payload.content,
        is_verified: payload.is_verified ? 'true' : 'false',
      },
      android: { priority: 'high', notification: { channelId: 'business_messages' } },
    });
    return true;
  } catch {
    return false;
  }
}

/** Firebase multicast limit is 500 tokens per request. */
export async function sendBusinessMessageMulticast(
  tokens: string[],
  payload: {
    message_id: string;
    business_id: string;
    business_name: string;
    channel_id: string;
    content: string;
    is_verified: boolean;
  },
): Promise<{ successCount: number; failureCount: number; successes: boolean[] }> {
  const messaging = getMessaging();
  if (!messaging || tokens.length === 0) {
    return {
      successCount: 0,
      failureCount: tokens.length,
      successes: tokens.map(() => false),
    };
  }

  const preview = payload.content.length > 120 ? `${payload.content.slice(0, 117)}…` : payload.content;
  let successCount = 0;
  let failureCount = 0;
  const successes: boolean[] = [];

  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    try {
      const res = await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: { title: payload.business_name, body: preview },
        data: {
          type: 'business_message',
          message_id: payload.message_id,
          business_id: payload.business_id,
          business_name: payload.business_name,
          channel_id: payload.channel_id,
          content: payload.content,
          is_verified: payload.is_verified ? 'true' : 'false',
        },
        android: { priority: 'high', notification: { channelId: 'business_messages' } },
      });
      res.responses.forEach((r, idx) => {
        const ok = r.success;
        successes.push(ok);
        if (ok) successCount += 1;
        else failureCount += 1;
      });
    } catch {
      chunk.forEach(() => {
        successes.push(false);
        failureCount += 1;
      });
    }
  }

  return { successCount, failureCount, successes };
}
