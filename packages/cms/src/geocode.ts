import type { GeoPoint } from './geo.js'

// Address search for map fields. The editor only knows the `Geocoder` function type, so any
// service (Nominatim, Photon, Mapbox, Google, your own endpoint) can be plugged in.

/** A box in WGS 84 degrees. */
export interface GeoBounds {
  south: number
  west: number
  north: number
  east: number
}

/** One match of an address search. */
export interface GeocodeResult {
  /** What the list shows, such as `Dam, Amsterdam, Netherlands`. */
  label: string
  lat: number
  lng: number
  /** Extent of the place; the map fits it when given (a city shows the whole city). */
  bounds?: GeoBounds
}

export interface GeocodeOptions {
  /** Aborted when the user starts another search or leaves the field. */
  signal: AbortSignal
  /** The area the map shows, for services that rank nearby results first. */
  near?: GeoPoint
}

/**
 * Looks up places for a search text. The editor calls it when the user presses Enter or the
 * Search button, never while typing.
 */
export interface Geocoder {
  (query: string, options: GeocodeOptions): Promise<GeocodeResult[]>
  /** Credit shown under the results, when the service's terms ask for one. */
  attribution?: string
}

export interface NominatimOptions {
  /** Search endpoint. Default: the public OpenStreetMap instance. */
  endpoint?: string
  /** Contact address sent with every request, so the operator can reach you instead of blocking you. */
  email?: string
  /** Only return places in these countries (ISO 3166-1 alpha-2, such as `['nl', 'be']`). */
  countryCodes?: string[]
  /** Language of the labels, such as `'nl'` or `'en,de'`. Default: the browser's languages. */
  language?: string
  /** Number of results. Default: 5. */
  limit?: number
  /** Milliseconds between requests to `endpoint`. Default: 1000, the public instance's maximum rate. */
  interval?: number
  /** Results kept in memory, so repeated searches send no request. Default: 100. */
  cacheSize?: number
  /** For tests and server-side use. Default: the global `fetch`. */
  fetch?: typeof globalThis.fetch
}

export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search'

/** When the next request to each endpoint may start, shared by every geocoder using it. */
const nextRequestAt = new Map<string, number>()

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The search was aborted', 'AbortError')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Wait until `endpoint` may be called again, and claim that slot. */
async function waitForTurn(endpoint: string, interval: number, signal: AbortSignal): Promise<void> {
  const now = Date.now()
  const at = Math.max(now, nextRequestAt.get(endpoint) ?? 0)
  nextRequestAt.set(endpoint, at + interval)
  if (at > now) await sleep(at - now, signal)
}

interface NominatimPlace {
  display_name: string
  lat: string
  lon: string
  /** `[south, north, west, east]`, as strings. */
  boundingbox?: [string, string, string, string]
}

function toResult(place: NominatimPlace): GeocodeResult {
  const result: GeocodeResult = { label: place.display_name, lat: Number(place.lat), lng: Number(place.lon) }
  const box = place.boundingbox?.map(Number)
  if (box && box.length === 4 && box.every(Number.isFinite)) {
    result.bounds = { south: box[0], north: box[1], west: box[2], east: box[3] }
  }
  return result
}

/**
 * Address search with [Nominatim](https://nominatim.org), OpenStreetMap's geocoder.
 *
 * The public instance is free under its [usage policy](https://operations.osmfoundation.org/policies/nominatim/):
 * at most one request per second for your whole app, an identified application, no search as you
 * type, results cached, and the OpenStreetMap attribution shown. This geocoder spaces requests
 * to the same endpoint at least `interval` apart (also across fields and geocoder instances),
 * caches results, sends the page's origin as `Referer` and `email` when given, and the editor
 * only searches on Enter. For more traffic, run your own instance or use a commercial provider,
 * and pass its `endpoint`.
 */
export function nominatimGeocoder(options: NominatimOptions = {}): Geocoder {
  const endpoint = options.endpoint ?? NOMINATIM_ENDPOINT
  const interval = options.interval ?? 1000
  const cacheSize = options.cacheSize ?? 100
  const cache = new Map<string, GeocodeResult[]>()

  const geocoder: Geocoder = async (query, { signal, near }) => {
    const params = new URLSearchParams({ q: query.trim().replace(/\s+/g, ' '), format: 'jsonv2', limit: String(options.limit ?? 5) })
    if (options.countryCodes?.length) params.set('countrycodes', options.countryCodes.join(',').toLowerCase())
    if (options.language) params.set('accept-language', options.language)
    if (options.email) params.set('email', options.email)
    if (near) {
      // Rank results around the map first, without excluding others. Rounded to 0.1° so panning
      // a little does not defeat the cache.
      const lat = Math.round(near.lat * 10) / 10
      const lng = Math.round(near.lng * 10) / 10
      params.set('viewbox', [lng - 0.5, lat + 0.5, lng + 0.5, lat - 0.5].map((n) => n.toFixed(1)).join(','))
    }
    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}${params}`
    const key = url.toLowerCase()

    const cached = cache.get(key)
    if (cached) {
      // Refresh its position, so the cache drops the least recently used result first.
      cache.delete(key)
      cache.set(key, cached)
      return cached
    }

    if (signal.aborted) throw abortError(signal)
    await waitForTurn(endpoint, interval, signal)
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      signal,
      headers: { Accept: 'application/json' },
      // Identifies the site to the operator even when the page sets a stricter referrer policy.
      referrerPolicy: 'strict-origin-when-cross-origin',
    })
    if (response.status === 429) throw new Error('Too many searches. Wait a moment and try again.')
    if (!response.ok) throw new Error(`Address search failed (HTTP ${response.status})`)
    const results = ((await response.json()) as NominatimPlace[]).map(toResult)

    cache.set(key, results)
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value!)
    return results
  }
  geocoder.attribution = 'Search © OpenStreetMap contributors'
  return geocoder
}
