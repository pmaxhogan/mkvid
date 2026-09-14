/**
 * Turn the recording URL tracked found on a 1001tracklists page into one
 * yt-dlp accepts.
 *
 * - SoundCloud: `https://api.soundcloud.com/tracks/<id>` resolves as-is
 *   (yt-dlp's SoundCloud extractor takes API track URLs without cookies).
 * - hearthis.at: 1001tracklists embeds the *player* (`hearthis.at/embed/<id>/`
 *   or `app.hearthis.at/embed/<id>/…`), but yt-dlp's HearThisAt extractor only
 *   knows the track page, `hearthis.at/<artist>/<slug>/`. The embed page's
 *   HTML links that page, so one fetch resolves it.
 */

const HEARTHIS_EMBED_RE = /^https?:\/\/(?:app\.|www\.)?hearthis\.at\/embed\/(\d+)\/?/i
const HEARTHIS_PAGE_RE = /https?:\/\/(?:www\.)?hearthis\.at\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_.-]*)\/?/gi
const HEARTHIS_RESERVED = new Set(['embed', 'user', 'users', 'api', 'api-v2', 'search', 'tag', 'tags', 'genre', 'genres', 'static', 'app', 'apps', 'img', 'css', 'js'])

export function isHearthisEmbed(url: string): boolean {
  return HEARTHIS_EMBED_RE.test(url)
}

/** The first hearthis track-page URL in an embed page's HTML, or null. */
export function extractHearthisTrackPage(html: string): string | null {
  HEARTHIS_PAGE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = HEARTHIS_PAGE_RE.exec(html))) {
    if (HEARTHIS_RESERVED.has(m[1]!.toLowerCase())) continue
    return `https://hearthis.at/${m[1]}/${m[2]}/`
  }
  return null
}

export async function resolveSourceUrl(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  const m = url.match(HEARTHIS_EMBED_RE)
  if (!m) return url
  const embedUrl = `https://hearthis.at/embed/${m[1]}/`
  const res = await fetcher(embedUrl, { headers: { 'user-agent': 'mkvid (+https://github.com/pmaxhogan/mkvid)' } })
  if (!res.ok) throw new Error(`hearthis embed ${m[1]}: HTTP ${res.status}`)
  const page = extractHearthisTrackPage(await res.text())
  if (!page) throw new Error(`hearthis embed ${m[1]}: no track page link found`)
  return page
}
