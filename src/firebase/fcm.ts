import { Env } from '../config';
import { getGoogleOAuthToken } from './oauth';

export interface FcmNotificationPayload {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export async function sendFcmNotification(
  env: Env,
  payload: FcmNotificationPayload
): Promise<boolean> {
  if (!payload.token || payload.token.trim().length === 0) {
    return false;
  }

  try {
    const accessToken = await getGoogleOAuthToken(env);
    const url = `https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`;

    const message = {
      message: {
        token: payload.token,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data || {},
        android: {
          priority: 'high',
          notification: {
            channel_id: 'subscription_alerts',
            sound: 'default',
          },
        },
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn(`FCM send warning (${res.status}):`, err);
      return false;
    }

    return true;
  } catch (err) {
    console.error('FCM send exception:', err);
    return false;
  }
}

