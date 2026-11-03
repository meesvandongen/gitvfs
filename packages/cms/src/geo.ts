import { z } from 'zod'
import { field, type CmsFieldConfig } from './fields.js'
import type { Geocoder } from './geocode.js'

// Map fields store plain `{ lat, lng }` objects, the shape Sanity, Contentful, DatoCMS and Hygraph
// use, rather than GeoJSON. Content files are read and edited by people, and `lat: 52.37` cannot be
// mixed up the way GeoJSON's `[longitude, latitude]` pairs often are. Use `toGeoJSON` to convert.

/** A WGS 84 coordinate, in degrees. */
export interface GeoPoint {
  lat: number
  lng: number
}

/** A point with a range around it, such as a delivery or service radius. `radius` is in meters. */
export interface GeoCircle extends GeoPoint {
  radius: number
}

/** A raster tile layer. `url` holds `{z}`, `{x}` and `{y}`, and optionally `{s}` for `subdomains`. */
export interface MapTiles {
  url: string
  /** Credit shown on the map, required by most tile providers. */
  attribution: string
  /** Link for the attribution. */
  attributionUrl?: string
  /** Highest zoom level the provider serves. Default: 19. */
  maxZoom?: number
  subdomains?: string[]
}

/** OpenStreetMap's standard tiles. Fine for an editor; see their usage policy before heavy use. */
export const OSM_TILES: MapTiles = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '© OpenStreetMap contributors',
  attributionUrl: 'https://www.openstreetmap.org/copyright',
  maxZoom: 19,
}

/** How the map of a geo field opens and behaves. */
export interface MapOptions {
  /** Where the map opens when the field is empty. Default: `{ lat: 20, lng: 0 }`. */
  center?: GeoPoint
  /** Zoom level the map opens at when the field is empty. Default: 2. */
  zoom?: number
  /** Zoom level used to show a single point. Default: 15. */
  pointZoom?: number
  /** Decimals kept when a coordinate is picked on the map. Default: 6 (about 10 cm). */
  decimals?: number
  /** Height of the map in pixels. Default: 320. */
  height?: number
  /** Tile layer. Default: `OSM_TILES`. */
  tiles?: MapTiles
  /** Address search shown above the map, such as `nominatimGeocoder()`. Default: none. */
  geocoder?: Geocoder
}

export interface GeoCircleOptions extends MapOptions {
  /** Radius, in meters, of a circle placed on an empty field. Default: 1000, within the bounds. */
  defaultRadius?: number
  /** Smallest allowed radius in meters. Default: 0. */
  minRadius?: number
  /** Largest allowed radius in meters. Shows a slider when set. */
  maxRadius?: number
}

export interface GeoShapeOptions extends MapOptions {
  /** Fewest points the shape needs. Default: 2 for a line, 3 for a polygon. */
  minPoints?: number
  maxPoints?: number
}

export interface GeoPointsOptions extends MapOptions {
  /** Fewest markers. Default: 1 (an empty list is saved as absent; use `.optional()` to allow it). */
  minPoints?: number
  maxPoints?: number
  /** Give every marker an optional name, such as a branch or a stop. Default: false. */
  labels?: boolean
}

/** A marker of a `geoPoints` field; `label` only exists with `labels: true`. */
export interface GeoMarker extends GeoPoint {
  label?: string
}

/** Editor options of a geo field, without `fieldType` (set by the helper). */
export type GeoFieldConfig<O extends MapOptions = MapOptions> = Omit<CmsFieldConfig, 'fieldType' | 'customData'> & O

/** Where geo fields keep their map options in AutoForm's `customData`. */
export interface GeoCustomData {
  map: GeoCircleOptions & GeoShapeOptions & GeoPointsOptions
}

const MAP_OPTION_KEYS = [
  'center',
  'zoom',
  'pointZoom',
  'decimals',
  'height',
  'tiles',
  'defaultRadius',
  'minRadius',
  'maxRadius',
  'minPoints',
  'maxPoints',
  'geocoder',
  'labels',
] as const

function splitConfig(config: GeoFieldConfig<GeoCustomData['map']>, fieldType: string) {
  const fieldConfig: Record<string, unknown> = {}
  const map: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if ((MAP_OPTION_KEYS as readonly string[]).includes(key)) map[key] = value
    else fieldConfig[key] = value
  }
  return field({ ...(fieldConfig as CmsFieldConfig), fieldType, customData: { map } satisfies { map: object } })
}

const latitude = () => z.number().min(-90, 'Latitude is at least -90').max(90, 'Latitude is at most 90')
const longitude = () => z.number().min(-180, 'Longitude is at least -180').max(180, 'Longitude is at most 180')
const pointShape = () => z.object({ lat: latitude(), lng: longitude() })

/**
 * A coordinate picked on a map: `{ lat, lng }`.
 *
 * ```ts
 * location: geoPoint({ label: 'Venue', center: { lat: 52.37, lng: 4.9 }, zoom: 11 }).optional()
 * ```
 */
export function geoPoint(config: GeoFieldConfig = {}) {
  return pointShape().check(splitConfig(config, 'geopoint'))
}

/** A point with a range around it, drawn as a circle: `{ lat, lng, radius }`, radius in meters. */
export function geoCircle(config: GeoFieldConfig<GeoCircleOptions> = {}) {
  let radius = z.number().min(config.minRadius ?? 0, `Radius is at least ${formatDistance(config.minRadius ?? 0)}`)
  if (config.maxRadius !== undefined) radius = radius.max(config.maxRadius, `Radius is at most ${formatDistance(config.maxRadius)}`)
  return z.object({ lat: latitude(), lng: longitude(), radius }).check(splitConfig(config, 'geocircle'))
}

function shape(config: GeoFieldConfig<GeoShapeOptions>, fieldType: string, fallbackMin: number) {
  const min = config.minPoints ?? fallbackMin
  let points = z.array(pointShape()).min(min, `Add at least ${min} points`)
  if (config.maxPoints !== undefined) points = points.max(config.maxPoints, `Use at most ${config.maxPoints} points`)
  return points.check(splitConfig({ ...config, minPoints: min }, fieldType))
}

/** A path drawn on a map, such as a route: an array of `{ lat, lng }`. */
export function geoLine(config: GeoFieldConfig<GeoShapeOptions> = {}) {
  return shape(config, 'geoline', 2)
}

/** An area drawn on a map: an array of `{ lat, lng }` corners. The ring closes itself. */
export function geoPolygon(config: GeoFieldConfig<GeoShapeOptions> = {}) {
  return shape(config, 'geopolygon', 3)
}

/**
 * Several markers in one field, such as branches or stops: an array of `{ lat, lng }`, or of
 * `{ lat, lng, label? }` with `labels: true`.
 *
 * ```ts
 * branches: geoPoints({ label: 'Branches', labels: true, maxPoints: 20 }).optional()
 * ```
 */
export function geoPoints(config: GeoFieldConfig<GeoPointsOptions> = {}) {
  const min = config.minPoints ?? 1
  const marker = config.labels ? pointShape().extend({ label: z.string().optional() }) : pointShape()
  let markers = z.array(marker).min(min, min === 1 ? 'Add at least 1 marker' : `Add at least ${min} markers`)
  if (config.maxPoints !== undefined) markers = markers.max(config.maxPoints, `Use at most ${config.maxPoints} markers`)
  return markers.check(splitConfig({ ...config, minPoints: min }, 'geopoints'))
}

// --- Geometry ------------------------------------------------------------------------------------

/** Mean earth radius in meters, as used by web maps. */
export const EARTH_RADIUS = 6_371_008.8
/** Web Mercator stops here; the poles are infinitely far away. */
export const MAX_LATITUDE = 85.0511287798
/** Tile size in pixels. */
export const TILE_SIZE = 256

const toRadians = (degrees: number) => (degrees * Math.PI) / 180
const toDegrees = (radians: number) => (radians * 180) / Math.PI
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Round a coordinate to `decimals` places. */
export function roundCoordinate(value: number, decimals = 6): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/** Bring a longitude back into [-180, 180], for points picked after panning around the globe. */
export function wrapLongitude(lng: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180
  return wrapped === -180 && lng > 0 ? 180 : wrapped
}

/** Pixel position of a coordinate in the Web Mercator world at `zoom`. */
export function project(point: GeoPoint, zoom: number): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** zoom
  const sin = Math.sin(toRadians(clamp(point.lat, -MAX_LATITUDE, MAX_LATITUDE)))
  return {
    x: ((point.lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  }
}

/** Coordinate at a pixel position of the Web Mercator world at `zoom`. */
export function unproject(pixel: { x: number; y: number }, zoom: number): GeoPoint {
  const scale = TILE_SIZE * 2 ** zoom
  return {
    lat: toDegrees(Math.atan(Math.sinh(Math.PI - (2 * Math.PI * pixel.y) / scale))),
    lng: (pixel.x / scale) * 360 - 180,
  }
}

/** Equatorial radius that Web Mercator tiles are scaled to. */
const MERCATOR_RADIUS = 6_378_137

/** Meters covered by one pixel at `lat` and `zoom`. */
export function metersPerPixel(lat: number, zoom: number): number {
  return (2 * Math.PI * MERCATOR_RADIUS * Math.cos(toRadians(lat))) / (TILE_SIZE * 2 ** zoom)
}

/** Great-circle distance between two points, in meters. */
export function distance(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.lat - a.lat)
  const dLng = toRadians(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** The point `meters` away from `from` in direction `bearing` (degrees clockwise from north). */
export function destination(from: GeoPoint, meters: number, bearing: number): GeoPoint {
  const angular = meters / EARTH_RADIUS
  const theta = toRadians(bearing)
  const lat1 = toRadians(from.lat)
  const lng1 = toRadians(from.lng)
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(theta))
  const lng2 = lng1 + Math.atan2(Math.sin(theta) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2))
  return { lat: toDegrees(lat2), lng: wrapLongitude(toDegrees(lng2)) }
}

/** Length of a path in meters. */
export function pathLength(points: readonly GeoPoint[]): number {
  let total = 0
  for (let index = 1; index < points.length; index++) total += distance(points[index - 1], points[index])
  return total
}

/** Area enclosed by a ring of points, in square meters (spherical approximation). */
export function polygonArea(points: readonly GeoPoint[]): number {
  if (points.length < 3) return 0
  let total = 0
  for (let index = 0; index < points.length; index++) {
    const a = points[index]
    const b = points[(index + 1) % points.length]
    total += toRadians(b.lng - a.lng) * (2 + Math.sin(toRadians(a.lat)) + Math.sin(toRadians(b.lat)))
  }
  return Math.abs((total * EARTH_RADIUS * EARTH_RADIUS) / 2)
}

/** `850 m`, `12.4 km`. */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(meters < 10_000 ? 2 : 1).replace(/\.?0+$/, '')} km`
}

/** `850 m²`, `3.2 km²`. */
export function formatArea(squareMeters: number): string {
  if (squareMeters < 100_000) return `${Math.round(squareMeters)} m²`
  return `${(squareMeters / 1_000_000).toFixed(2).replace(/\.?0+$/, '')} km²`
}

/**
 * Read a coordinate pair as people paste it, such as `52.3731, 4.8922` (Google Maps' order: latitude
 * first) or `52.3731° N, 4.8922° E`. Returns `undefined` when the text is not a valid pair.
 */
export function parseCoordinates(text: string): GeoPoint | undefined {
  const match = /^\s*\(?\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?\s*\)?\s*$/i.exec(text)
  if (!match) return undefined
  const lat = Number(match[1]) * (match[2]?.toUpperCase() === 'S' ? -1 : 1)
  const lng = Number(match[3]) * (match[4]?.toUpperCase() === 'W' ? -1 : 1)
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined
  return { lat, lng }
}

/** Whether `value` is a `{ lat, lng }` with finite numbers. */
export function isGeoPoint(value: unknown): value is GeoPoint {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isFinite((value as GeoPoint).lat) &&
    Number.isFinite((value as GeoPoint).lng)
  )
}

type GeoJSONGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'MultiPoint'; coordinates: Array<[number, number]> }
  | { type: 'LineString'; coordinates: Array<[number, number]> }
  | { type: 'Polygon'; coordinates: Array<Array<[number, number]>> }

/**
 * Convert a geo field value to a GeoJSON geometry, for map libraries and geo databases. A circle
 * becomes its center point (GeoJSON has no circles); pass `{ polygon: true }` for a ring of points.
 * Lists become a LineString, a Polygon with `{ polygon: true }`, or, for `geoPoints` markers, a
 * MultiPoint with `{ multiPoint: true }` (labels are left out).
 */
export function toGeoJSON(value: GeoPoint | GeoCircle, options?: { polygon?: false }): GeoJSONGeometry
export function toGeoJSON(value: GeoCircle, options: { polygon: true; steps?: number }): GeoJSONGeometry
export function toGeoJSON(value: readonly GeoMarker[], options?: { polygon?: boolean; multiPoint?: boolean }): GeoJSONGeometry
export function toGeoJSON(
  value: GeoPoint | GeoCircle | readonly GeoPoint[],
  options: { polygon?: boolean; multiPoint?: boolean; steps?: number } = {},
): GeoJSONGeometry {
  const pair = (point: GeoPoint): [number, number] => [point.lng, point.lat]
  if (Array.isArray(value)) {
    const points = value as readonly GeoPoint[]
    if (options.multiPoint) return { type: 'MultiPoint', coordinates: points.map(pair) }
    if (!options.polygon) return { type: 'LineString', coordinates: points.map(pair) }
    const ring = points.map(pair)
    if (ring.length > 0) ring.push(ring[0])
    return { type: 'Polygon', coordinates: [ring] }
  }
  const point = value as GeoPoint | GeoCircle
  if (options.polygon && 'radius' in point) {
    const steps = options.steps ?? 64
    return toGeoJSON(
      Array.from({ length: steps }, (_, index) => destination(point, point.radius, (index * 360) / steps)),
      { polygon: true },
    )
  }
  return { type: 'Point', coordinates: pair(point) }
}
