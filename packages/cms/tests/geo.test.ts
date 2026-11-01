import { z } from 'zod'
import {
  destination,
  distance,
  formatArea,
  formatDistance,
  geoCircle,
  geoLine,
  geoPoint,
  geoPolygon,
  metersPerPixel,
  parseCoordinates,
  pathLength,
  polygonArea,
  project,
  roundCoordinate,
  toGeoJSON,
  unproject,
  wrapLongitude,
} from '../src'
import { fitView } from '../src/react'

const amsterdam = { lat: 52.3731, lng: 4.8922 }
const utrecht = { lat: 52.0907, lng: 5.1214 }

describe('geo schemas', () => {
  it('validates points and keeps map options for the editor', () => {
    const schema = geoPoint({ label: 'Venue', zoom: 11, decimals: 5 })
    expect(schema.parse(amsterdam)).toEqual(amsterdam)
    expect(schema.safeParse({ lat: 91, lng: 0 }).success).toBe(false)
    expect(schema.safeParse({ lat: 0, lng: -181 }).success).toBe(false)
    expect(z.object({ venue: schema.optional() }).parse({})).toEqual({})
  })

  it('bounds the radius of circles', () => {
    const schema = geoCircle({ minRadius: 100, maxRadius: 5000 })
    expect(schema.parse({ ...amsterdam, radius: 2500 }).radius).toBe(2500)
    expect(schema.safeParse({ ...amsterdam, radius: 50 }).error?.issues[0].message).toBe('Radius is at least 100 m')
    expect(schema.safeParse({ ...amsterdam, radius: 6000 }).error?.issues[0].message).toBe('Radius is at most 5 km')
  })

  it('requires enough points for lines and polygons', () => {
    expect(geoLine().safeParse([amsterdam]).error?.issues[0].message).toBe('Add at least 2 points')
    expect(geoLine().safeParse([amsterdam, utrecht]).success).toBe(true)
    expect(geoPolygon().safeParse([amsterdam, utrecht]).success).toBe(false)
    expect(geoPolygon({ maxPoints: 3 }).safeParse([amsterdam, utrecht, amsterdam, utrecht]).success).toBe(false)
  })
})

describe('geometry', () => {
  it('projects and unprojects Web Mercator pixels', () => {
    expect(project({ lat: 0, lng: 0 }, 0)).toEqual({ x: 128, y: 128 })
    const back = unproject(project(amsterdam, 12), 12)
    expect(back.lat).toBeCloseTo(amsterdam.lat, 9)
    expect(back.lng).toBeCloseTo(amsterdam.lng, 9)
    expect(metersPerPixel(0, 0)).toBeCloseTo(156_543, 0)
  })

  it('measures distances, paths and areas', () => {
    expect(distance(amsterdam, utrecht) / 1000).toBeCloseTo(35.0, 0)
    expect(pathLength([amsterdam, utrecht, amsterdam])).toBeCloseTo(2 * distance(amsterdam, utrecht), 6)
    const east = destination(amsterdam, 1000, 90)
    expect(distance(amsterdam, east)).toBeCloseTo(1000, 3)
    // A 0.01° square at the equator is about 1.11 km on each side.
    const square = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.01 },
      { lat: 0.01, lng: 0.01 },
      { lat: 0.01, lng: 0 },
    ]
    expect(polygonArea(square) / 1_000_000).toBeCloseTo(1.236, 2)
  })

  it('formats and rounds', () => {
    expect(formatDistance(850)).toBe('850 m')
    expect(formatDistance(1500)).toBe('1.5 km')
    expect(formatDistance(12_345)).toBe('12.3 km')
    expect(formatArea(500)).toBe('500 m²')
    expect(formatArea(3_200_000)).toBe('3.2 km²')
    expect(roundCoordinate(52.373_123_456, 4)).toBe(52.3731)
    expect(wrapLongitude(190)).toBe(-170)
    expect(wrapLongitude(-540)).toBe(-180)
    expect(wrapLongitude(180)).toBe(180)
  })

  it('parses pasted coordinates', () => {
    expect(parseCoordinates('52.3731, 4.8922')).toEqual(amsterdam)
    expect(parseCoordinates('(52.3731 4.8922)')).toEqual(amsterdam)
    expect(parseCoordinates('33.86° S, 151.21° E')).toEqual({ lat: -33.86, lng: 151.21 })
    expect(parseCoordinates('40.7, -74')).toEqual({ lat: 40.7, lng: -74 })
    expect(parseCoordinates('95, 4')).toBeUndefined()
    expect(parseCoordinates('Amsterdam')).toBeUndefined()
  })

  it('converts to GeoJSON with longitude first', () => {
    expect(toGeoJSON(amsterdam)).toEqual({ type: 'Point', coordinates: [4.8922, 52.3731] })
    expect(toGeoJSON([amsterdam, utrecht])).toEqual({ type: 'LineString', coordinates: [[4.8922, 52.3731], [5.1214, 52.0907]] })
    const polygon = toGeoJSON([amsterdam, utrecht, { lat: 52, lng: 4 }], { polygon: true })
    expect(polygon.type).toBe('Polygon')
    expect((polygon.coordinates as number[][][])[0]).toHaveLength(4)
    const circle = toGeoJSON({ ...amsterdam, radius: 500 }, { polygon: true, steps: 8 })
    expect((circle.coordinates as number[][][])[0]).toHaveLength(9)
  })

  it('fits views around points', () => {
    const size = { width: 600, height: 320 }
    expect(fitView([], size, { center: amsterdam, zoom: 9 })).toEqual({ center: amsterdam, zoom: 9 })
    expect(fitView([amsterdam], size)).toEqual({ center: amsterdam, zoom: 15 })
    const both = fitView([amsterdam, utrecht], size)
    expect(both.zoom).toBe(9)
    expect(both.center.lat).toBeGreaterThan(utrecht.lat)
    expect(both.center.lat).toBeLessThan(amsterdam.lat)
    // A 1 km circle fits at a closer zoom than a 10 km one.
    expect(fitView([amsterdam], size, { padding: 1000 }).zoom).toBeGreaterThan(fitView([amsterdam], size, { padding: 10_000 }).zoom)
  })
})
