import webpush from 'web-push'
import type { Config } from '../config.js'
import type { PushSubscriptionRecord } from '../types.js'
import { log } from './log.js'

export function initWebPush(vapid: NonNullable<Config['vapid']>): void {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)
}

export async function sendPush(
  vapid: Config['vapid'], subs: PushSubscriptionRecord[],
  payload: { title: string; body: string; url: string }, onGone: (endpoint: string) => void,
): Promise<void> {
  if (!vapid) return
  const body = JSON.stringify(payload)
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body)
    } catch (e: any) {
      const code = e?.statusCode
      if (code === 404 || code === 410) onGone(s.endpoint)
      else log('warn', 'push send failed', { endpoint: s.endpoint, code })
    }
  }))
}
