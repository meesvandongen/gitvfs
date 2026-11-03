import { nominatimGeocoder, type NominatimOptions } from '../src'

const dam = {
  display_name: 'Dam, Amsterdam, Noord-Holland, Nederland',
  lat: '52.3731',
  lon: '4.8926',
  boundingbox: ['52.3725', '52.3737', '4.8915', '4.8937'],
}

/** A fresh endpoint per test, since the rate limit is shared by everything using an endpoint. */
let endpoints = 0
const nextEndpoint = () => `https://geocoder${++endpoints}.example/search`

function setup(options: NominatimOptions = {}, respond = () => Response.json([dam])) {
  const requests: Array<{ url: URL; init?: RequestInit }> = []
  // The geocoder passes a URL string.
  const fetch = async (input: string, init?: RequestInit) => {
    requests.push({ url: new URL(input), init })
    return respond()
  }
  const endpoint = options.endpoint ?? nextEndpoint()
  const geocoder = nominatimGeocoder({ endpoint, fetch: fetch as typeof globalThis.fetch, ...options })
  return { geocoder, requests, endpoint, fetch: fetch as typeof globalThis.fetch }
}

const signal = () => new AbortController().signal

afterEach(() => vi.useRealTimers())

describe('nominatimGeocoder', () => {
  it('sends an identified request and reads the results', async () => {
    const { geocoder, requests } = setup({ email: 'dev@example.com', countryCodes: ['NL', 'be'], language: 'nl', limit: 3 })
    const results = await geocoder('  Dam   Amsterdam ', { signal: signal(), near: { lat: 52.3731, lng: 4.8926 } })

    expect(results).toEqual([
      {
        label: 'Dam, Amsterdam, Noord-Holland, Nederland',
        lat: 52.3731,
        lng: 4.8926,
        bounds: { south: 52.3725, north: 52.3737, west: 4.8915, east: 4.8937 },
      },
    ])
    const { url, init } = requests[0]
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'Dam Amsterdam',
      format: 'jsonv2',
      limit: '3',
      countrycodes: 'nl,be',
      'accept-language': 'nl',
      email: 'dev@example.com',
      // Ranked around the map, rounded so small pans hit the cache.
      viewbox: '4.4,52.9,5.4,51.9',
    })
    expect(init?.referrerPolicy).toBe('strict-origin-when-cross-origin')
    expect(geocoder.attribution).toContain('OpenStreetMap')
  })

  it('answers repeated searches from its cache', async () => {
    const { geocoder, requests } = setup({ interval: 0 })
    await geocoder('Dam', { signal: signal() })
    await geocoder(' dam ', { signal: signal() })
    expect(requests).toHaveLength(1)
    await geocoder('Dam', { signal: signal(), near: { lat: 52.37, lng: 4.89 } })
    await geocoder('Dam', { signal: signal(), near: { lat: 52.38, lng: 4.9 } })
    expect(requests).toHaveLength(2)
  })

  it('forgets the least recently used results beyond cacheSize', async () => {
    const { geocoder, requests } = setup({ interval: 0, cacheSize: 2 })
    for (const query of ['a', 'b', 'a', 'c', 'a', 'b']) await geocoder(query, { signal: signal() })
    // `b` was dropped when `c` came in, as `a` had been used more recently.
    expect(requests.map(({ url }) => url.searchParams.get('q'))).toEqual(['a', 'b', 'c', 'b'])
  })

  it('sends at most one request per second to an endpoint, across geocoders', async () => {
    vi.useFakeTimers()
    const first = setup()
    const second = setup({ endpoint: first.endpoint })
    const searches = [
      first.geocoder('one', { signal: signal() }),
      second.geocoder('two', { signal: signal() }),
      first.geocoder('three', { signal: signal() }),
    ]
    const sent = () => first.requests.length + second.requests.length
    await vi.advanceTimersByTimeAsync(0)
    expect(sent()).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(sent()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sent()).toBe(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent()).toBe(3)
    await Promise.all(searches)

    // Another endpoint has its own budget.
    const other = setup()
    await other.geocoder('four', { signal: signal() })
    expect(other.requests).toHaveLength(1)
  })

  it('stops waiting when the search is aborted', async () => {
    vi.useFakeTimers()
    const { geocoder, requests } = setup()
    await geocoder('one', { signal: signal() })
    const controller = new AbortController()
    const waiting = geocoder('two', { signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(requests).toHaveLength(1)
  })

  it('reports failed requests', async () => {
    const limited = setup({ interval: 0 }, () => new Response('', { status: 429 }))
    await expect(limited.geocoder('Dam', { signal: signal() })).rejects.toThrow('Too many searches')
    const broken = setup({ interval: 0 }, () => new Response('', { status: 503 }))
    await expect(broken.geocoder('Dam', { signal: signal() })).rejects.toThrow('Address search failed (HTTP 503)')
    // Failures are not cached.
    await expect(broken.geocoder('Dam', { signal: signal() })).rejects.toThrow()
    expect(broken.requests).toHaveLength(2)
  })
})
