export const SERVICE_WORKER_JS = `
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch (e) {}
  const title = data.title || 'mkvid'
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '', data: { url: data.url || '/' }, icon: '/favicon.ico', tag: 'mkvid-job',
  }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url === url && 'focus' in c) return c.focus() }
    return clients.openWindow(url)
  }))
})
`.trim()
