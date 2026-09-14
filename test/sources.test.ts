import { describe, it, expect } from 'vitest'
import { extractHearthisTrackPage, isHearthisEmbed, resolveSourceUrl } from '../src/lib/sources.js'

describe('sources', () => {
  it('passes SoundCloud API urls and hearthis track pages through untouched', async () => {
    expect(await resolveSourceUrl('https://api.soundcloud.com/tracks/123')).toBe('https://api.soundcloud.com/tracks/123')
    expect(await resolveSourceUrl('https://hearthis.at/dj/my-set/')).toBe('https://hearthis.at/dj/my-set/')
    expect(isHearthisEmbed('https://hearthis.at/dj/my-set/')).toBe(false)
  })

  it('resolves a hearthis embed to the track page linked from the embed HTML', async () => {
    const html = '<html><a href="https://hearthis.at/user/x/">user</a> <link rel="canonical" href="https://hearthis.at/paul-newman-ml/paul-newmans-smooth-sunday/"></html>'
    const fetcher = (async (url: string) => {
      expect(url).toBe('https://hearthis.at/embed/14673927/')
      return new Response(html, { status: 200 })
    }) as unknown as typeof fetch
    expect(await resolveSourceUrl('https://app.hearthis.at/embed/14673927/transparent_black/?x=1', fetcher)).toBe('https://hearthis.at/paul-newman-ml/paul-newmans-smooth-sunday/')
    expect(extractHearthisTrackPage(html)).toBe('https://hearthis.at/paul-newman-ml/paul-newmans-smooth-sunday/')
    expect(extractHearthisTrackPage('<a href="https://hearthis.at/embed/1/">e</a>')).toBeNull()
  })

  it('fails clearly on a dead embed', async () => {
    const fetcher = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch
    await expect(resolveSourceUrl('https://hearthis.at/embed/1/', fetcher)).rejects.toThrow('hearthis embed 1: HTTP 404')
    const empty = (async () => new Response('<html></html>', { status: 200 })) as unknown as typeof fetch
    await expect(resolveSourceUrl('https://hearthis.at/embed/1/', empty)).rejects.toThrow('no track page link')
  })
})
