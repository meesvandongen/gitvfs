import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { AutoFormFieldProps } from '@autoform/react'
import {
  OSM_TILES,
  TILE_SIZE,
  destination,
  distance,
  formatArea,
  formatDistance,
  isGeoPoint,
  metersPerPixel,
  parseCoordinates,
  pathLength,
  polygonArea,
  project,
  roundCoordinate,
  unproject,
  wrapLongitude,
  type GeoCircle,
  type GeoCustomData,
  type GeoPoint,
  type MapTiles,
} from '../geo.js'
import { NestedErrors } from './field-utils.js'

// Not imported from ./autoform.js, which imports this module for its field components.
const useField = (name: string) => useFieldRHF({ name }).field
import { useFieldRHF } from '@autoform/react/react-hook-form'

export interface MapView {
  center: GeoPoint
  zoom: number
}

interface Pixel {
  x: number
  y: number
}

/** Helpers handed to the overlay of a `SlippyMap`, in pixels of the map element. */
export interface MapOverlayHelpers {
  view: MapView
  size: { width: number; height: number }
  toPixel: (point: GeoPoint) => Pixel
  toPoint: (pixel: Pixel) => GeoPoint
  /** Pointer handlers that make an SVG element draggable; `onDrag` gets the coordinate under the pointer. */
  draggable: (onDrag: (point: GeoPoint) => void) => {
    onPointerDown: (event: ReactPointerEvent<Element>) => void
    onPointerMove: (event: ReactPointerEvent<Element>) => void
    onPointerUp: (event: ReactPointerEvent<Element>) => void
    onClick: (event: { stopPropagation(): void }) => void
  }
}

export interface SlippyMapProps {
  view: MapView
  onViewChange: (view: MapView) => void
  /** Called with the coordinate of a click (not a drag) on the map. */
  onMapClick?: (point: GeoPoint) => void
  tiles?: MapTiles
  height?: number
  /** Accessible name of the map. */
  label?: string
  /** SVG content drawn over the tiles. */
  children?: (helpers: MapOverlayHelpers) => ReactNode
}

const MIN_ZOOM = 1
/** Used until the element is measured, and where layout is not available (tests, SSR). */
const FALLBACK_WIDTH = 600
const DRAG_THRESHOLD = 4

function tileUrl(tiles: MapTiles, z: number, x: number, y: number): string {
  const subdomains = tiles.subdomains ?? []
  const s = subdomains.length > 0 ? subdomains[Math.abs(x + y) % subdomains.length] : ''
  return tiles.url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace('{s}', s)
}

function clampZoom(zoom: number, tiles: MapTiles) {
  return Math.min(tiles.maxZoom ?? 19, Math.max(MIN_ZOOM, Math.round(zoom)))
}

/**
 * A dependency-free raster map: tiles, drag to pan, buttons, Ctrl/⌘ + scroll and keys to zoom, and an
 * SVG overlay for markers and shapes. Zoom levels are whole numbers, so tiles stay sharp.
 */
export function SlippyMap({ view, onViewChange, onMapClick, tiles = OSM_TILES, height = 320, label = 'Map', children }: SlippyMapProps) {
  const element = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  const [hint, setHint] = useState(false)
  const size = useMemo(() => ({ width, height }), [width, height])

  useLayoutEffect(() => {
    const node = element.current
    if (!node) return
    const measure = () => {
      const measured = node.getBoundingClientRect().width
      if (measured > 0) setWidth(measured)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const zoom = clampZoom(view.zoom, tiles)
  const worldSize = TILE_SIZE * 2 ** zoom
  const centerPixel = project(view.center, zoom)
  const origin = { x: centerPixel.x - width / 2, y: centerPixel.y - height / 2 }

  const toPixel = (point: GeoPoint): Pixel => {
    const world = project(point, zoom)
    // Show the copy of the point nearest to the center, so markers survive panning across the date line.
    let x = world.x - centerPixel.x
    x -= Math.round(x / worldSize) * worldSize
    return { x: x + width / 2, y: world.y - origin.y }
  }
  const toPoint = (pixel: Pixel): GeoPoint => {
    const point = unproject({ x: pixel.x + origin.x, y: pixel.y + origin.y }, zoom)
    return { lat: point.lat, lng: wrapLongitude(point.lng) }
  }

  // Latest values for the native listeners and drags below.
  const latest = useRef({ view, zoom, toPixel, toPoint, onViewChange, size })
  latest.current = { view, zoom, toPixel, toPoint, onViewChange, size }

  const zoomTo = useCallback(
    (nextZoom: number, anchor?: Pixel) => {
      const { view: current, zoom: currentZoom, toPoint: pointAt, onViewChange: change, size: box } = latest.current
      const target = clampZoom(nextZoom, tiles)
      if (target === currentZoom) return
      if (!anchor) {
        change({ center: current.center, zoom: target })
        return
      }
      // Keep the coordinate under the pointer in place.
      const fixed = project(pointAt(anchor), target)
      const center = unproject({ x: fixed.x - anchor.x + box.width / 2, y: fixed.y - anchor.y + box.height / 2 }, target)
      change({ center: { lat: center.lat, lng: wrapLongitude(center.lng) }, zoom: target })
    },
    [tiles],
  )

  const panBy = (dx: number, dy: number) => {
    const center = unproject({ x: centerPixel.x + dx, y: centerPixel.y + dy }, zoom)
    onViewChange({ center: { lat: center.lat, lng: wrapLongitude(center.lng) }, zoom })
  }

  // Scrolling over a map in a long form should scroll the form; zoom only with Ctrl or ⌘ held.
  useEffect(() => {
    const node = element.current
    if (!node) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        setHint(true)
        clearTimeout(timer)
        timer = setTimeout(() => setHint(false), 1200)
        return
      }
      event.preventDefault()
      const rect = node.getBoundingClientRect()
      zoomTo(latest.current.zoom + (event.deltaY < 0 ? 1 : -1), { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      clearTimeout(timer)
      node.removeEventListener('wheel', onWheel)
    }
  }, [zoomTo])

  const localPixel = (event: { clientX: number; clientY: number }): Pixel => {
    const rect = element.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  // Panning: drag the map. A press that barely moves is a click.
  const pan = useRef<{ id: number; start: Pixel; center: Pixel; moved: boolean } | null>(null)
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    pan.current = { id: event.pointerId, start: localPixel(event), center: centerPixel, moved: false }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = pan.current
    if (!state || state.id !== event.pointerId) return
    const now = localPixel(event)
    const dx = now.x - state.start.x
    const dy = now.y - state.start.y
    if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    state.moved = true
    const center = unproject({ x: state.center.x - dx, y: state.center.y - dy }, zoom)
    onViewChange({ center: { lat: center.lat, lng: wrapLongitude(center.lng) }, zoom })
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = pan.current
    if (!state || state.id !== event.pointerId) return
    pan.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (!state.moved && onMapClick) onMapClick(toPoint(localPixel(event)))
  }

  const draggable: MapOverlayHelpers['draggable'] = (onDrag) => ({
    onPointerDown: (event) => {
      if (event.button !== 0) return
      event.stopPropagation()
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    onPointerMove: (event) => {
      if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return
      event.stopPropagation()
      onDrag(latest.current.toPoint(localPixel(event)))
    },
    onPointerUp: (event) => {
      event.stopPropagation()
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    },
    onClick: (event) => event.stopPropagation(),
  })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = 80
    const actions: Record<string, () => void> = {
      ArrowLeft: () => panBy(-step, 0),
      ArrowRight: () => panBy(step, 0),
      ArrowUp: () => panBy(0, -step),
      ArrowDown: () => panBy(0, step),
      '+': () => zoomTo(zoom + 1),
      '=': () => zoomTo(zoom + 1),
      '-': () => zoomTo(zoom - 1),
    }
    const action = actions[event.key]
    if (action) {
      event.preventDefault()
      action()
    }
  }

  const tileCount = 2 ** zoom
  const images: ReactNode[] = []
  const firstX = Math.floor(origin.x / TILE_SIZE)
  const lastX = Math.floor((origin.x + width) / TILE_SIZE)
  const firstY = Math.max(0, Math.floor(origin.y / TILE_SIZE))
  const lastY = Math.min(tileCount - 1, Math.floor((origin.y + height) / TILE_SIZE))
  for (let x = firstX; x <= lastX; x++) {
    for (let y = firstY; y <= lastY; y++) {
      const wrappedX = ((x % tileCount) + tileCount) % tileCount
      images.push(
        <img
          key={`${zoom}/${x}/${y}`}
          className="gcms-map-tile"
          src={tileUrl(tiles, zoom, wrappedX, y)}
          alt=""
          draggable={false}
          width={TILE_SIZE}
          height={TILE_SIZE}
          style={{ transform: `translate(${Math.round(x * TILE_SIZE - origin.x)}px, ${Math.round(y * TILE_SIZE - origin.y)}px)` }}
        />,
      )
    }
  }

  const helpers: MapOverlayHelpers = { view: { center: view.center, zoom }, size, toPixel, toPoint, draggable }

  return (
    <div className="gcms-map" style={{ height }}>
      <div
        ref={element}
        className="gcms-map-viewport"
        role="group"
        aria-roledescription="map"
        aria-label={`${label}. Arrow keys pan, plus and minus zoom.`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (pan.current = null)}
        onKeyDown={onKeyDown}
      >
        <div className="gcms-map-tiles" aria-hidden>
          {images}
        </div>
        <svg className="gcms-map-overlay" width={width} height={height} aria-hidden>
          {children?.(helpers)}
        </svg>
        {hint ? <div className="gcms-map-hint">Hold Ctrl or ⌘ and scroll to zoom</div> : null}
      </div>
      <div className="gcms-map-zoom">
        <button type="button" className="gcms-map-button" aria-label="Zoom in" onClick={() => zoomTo(zoom + 1)} disabled={zoom >= (tiles.maxZoom ?? 19)}>
          +
        </button>
        <button type="button" className="gcms-map-button" aria-label="Zoom out" onClick={() => zoomTo(zoom - 1)} disabled={zoom <= MIN_ZOOM}>
          −
        </button>
      </div>
      <div className="gcms-map-attribution">
        {tiles.attributionUrl ? (
          <a href={tiles.attributionUrl} target="_blank" rel="noreferrer">
            {tiles.attribution}
          </a>
        ) : (
          tiles.attribution
        )}
      </div>
    </div>
  )
}

/** The view that shows `points` (and `padding` meters around them), within a map of `size`. */
export function fitView(
  points: readonly GeoPoint[],
  size: { width: number; height: number },
  options: { center?: GeoPoint; zoom?: number; pointZoom?: number; maxZoom?: number; padding?: number } = {},
): MapView {
  const maxZoom = options.maxZoom ?? 19
  if (points.length === 0) return { center: options.center ?? { lat: 20, lng: 0 }, zoom: options.zoom ?? 2 }
  const padded = options.padding
    ? points.flatMap((point) => [0, 90, 180, 270].map((bearing) => destination(point, options.padding!, bearing)))
    : points
  if (padded.length === 1) {
    return { center: points[0], zoom: Math.min(maxZoom, options.pointZoom ?? 15) }
  }
  const world = padded.map((point) => project(point, 0))
  const minX = Math.min(...world.map((p) => p.x))
  const maxX = Math.max(...world.map((p) => p.x))
  const minY = Math.min(...world.map((p) => p.y))
  const maxY = Math.max(...world.map((p) => p.y))
  const center = unproject({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, 0)
  const margin = 32
  let zoom = MIN_ZOOM
  for (let candidate = maxZoom; candidate >= MIN_ZOOM; candidate--) {
    const scale = 2 ** candidate
    if ((maxX - minX) * scale <= size.width - margin * 2 && (maxY - minY) * scale <= size.height - margin * 2) {
      zoom = candidate
      break
    }
  }
  return { center, zoom: Math.min(zoom, options.pointZoom ?? maxZoom) }
}

// --- Fields --------------------------------------------------------------------------------------

function mapOptions(props: AutoFormFieldProps): GeoCustomData['map'] {
  return (props.parsedField.fieldConfig?.customData as GeoCustomData | undefined)?.map ?? {}
}

/** A text input for one number that lets people type freely (`-`, `52.`) and reports finite values. */
function NumberInput({
  id,
  value,
  onChange,
  onPastePair,
  label,
  className,
  inputProps,
}: {
  id?: string
  value: number | undefined
  onChange: (value: number | undefined) => void
  onPastePair?: (point: GeoPoint) => void
  label: string
  className?: string
  inputProps?: Record<string, unknown>
}) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  useEffect(() => {
    // Follow changes from the map, but keep what the user is typing when it means the same number.
    setDraft((current) => (current.trim() !== '' && Number(current) === value ? current : value === undefined ? '' : String(value)))
  }, [value])
  return (
    <label className={`gcms-map-number ${className ?? ''}`}>
      <span>{label}</span>
      <input
        className="gcms-input"
        inputMode="decimal"
        autoComplete="off"
        {...inputProps}
        id={id}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          const text = event.target.value.trim()
          if (text === '') onChange(undefined)
          else if (Number.isFinite(Number(text))) onChange(Number(text))
        }}
        onPaste={
          onPastePair
            ? (event) => {
                const pair = parseCoordinates(event.clipboardData.getData('text'))
                if (pair) {
                  event.preventDefault()
                  onPastePair(pair)
                }
              }
            : undefined
        }
      />
    </label>
  )
}

function useMapView(points: readonly GeoPoint[], options: GeoCustomData['map'], padding?: number) {
  const [view, setView] = useState<MapView>(() =>
    fitView(points, { width: FALLBACK_WIDTH, height: options.height ?? 320 }, {
      ...options,
      maxZoom: options.tiles?.maxZoom,
      padding,
    }),
  )
  return [view, setView] as const
}

function round(point: GeoPoint, decimals?: number): GeoPoint {
  return { lat: roundCoordinate(point.lat, decimals), lng: roundCoordinate(wrapLongitude(point.lng), decimals) }
}

function Marker({ point, helpers, label, onMove }: { point: GeoPoint; helpers: MapOverlayHelpers; label: string; onMove?: (point: GeoPoint) => void }) {
  const { x, y } = helpers.toPixel(point)
  return (
    <g className={`gcms-map-marker${onMove ? ' gcms-map-draggable' : ''}`} transform={`translate(${x} ${y})`} {...(onMove ? helpers.draggable(onMove) : {})}>
      <title>{label}</title>
      <path d="M0 0 C -3 -9 -11 -13 -11 -21 A 11 11 0 1 1 11 -21 C 11 -13 3 -9 0 0 Z" />
      <circle cy={-21} r={4} />
    </g>
  )
}

function Vertex({ point, helpers, label, onMove }: { point: GeoPoint; helpers: MapOverlayHelpers; label: string; onMove: (point: GeoPoint) => void }) {
  const { x, y } = helpers.toPixel(point)
  return (
    <circle className="gcms-map-vertex gcms-map-draggable" cx={x} cy={y} r={6} {...helpers.draggable(onMove)}>
      <title>{label}</title>
    </circle>
  )
}

function useGeolocation() {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator
  const locate = (onFound: (point: GeoPoint) => void) => {
    if (!supported) return
    setState('busy')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setState('idle')
        onFound({ lat: position.coords.latitude, lng: position.coords.longitude })
      },
      () => setState('failed'),
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }
  return { supported, state, locate }
}

function PointControls({
  id,
  value,
  onChange,
  onClear,
  decimals,
  inputProps,
  children,
}: {
  id: string
  value: Partial<GeoPoint> | undefined
  onChange: (point: Partial<GeoPoint>) => void
  onClear: () => void
  decimals?: number
  inputProps?: Record<string, unknown>
  children?: ReactNode
}) {
  const geolocation = useGeolocation()
  const paste = (point: GeoPoint) => onChange(round(point, decimals))
  return (
    <div className="gcms-map-controls">
      <NumberInput id={id} label="Latitude" value={value?.lat} onChange={(lat) => onChange({ ...value, lat })} onPastePair={paste} inputProps={inputProps} />
      <NumberInput id={`${id}-lng`} label="Longitude" value={value?.lng} onChange={(lng) => onChange({ ...value, lng })} onPastePair={paste} />
      {children}
      <div className="gcms-map-actions">
        {geolocation.supported ? (
          <button
            type="button"
            className="gcms-button gcms-button--small"
            disabled={geolocation.state === 'busy'}
            onClick={() => geolocation.locate((point) => onChange(round(point, decimals)))}
          >
            {geolocation.state === 'busy' ? 'Locating…' : geolocation.state === 'failed' ? 'Location unavailable' : 'Use my location'}
          </button>
        ) : null}
        {value !== undefined ? (
          <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** Picks one coordinate: click the map or drag the marker, type or paste `lat, lng`, or use the device location. */
export function GeoPointField(props: AutoFormFieldProps) {
  const field = useField(props.id)
  const options = mapOptions(props)
  const value = (field.value ?? undefined) as Partial<GeoPoint> | undefined
  const point = isGeoPoint(value) ? value : undefined
  const [view, setView] = useMapView(point ? [point] : [], options)

  const set = (next: Partial<GeoPoint>, follow = false) => {
    field.onChange(next)
    if (follow && isGeoPoint(next)) setView((current) => ({ center: next, zoom: Math.max(current.zoom, options.pointZoom ?? 15) }))
  }

  return (
    <div className="gcms-geo" tabIndex={-1} ref={field.ref as never}>
      <SlippyMap
        view={view}
        onViewChange={setView}
        tiles={options.tiles}
        height={options.height}
        label={typeof props.label === 'string' ? props.label : 'Map'}
        onMapClick={(clicked) => set(round(clicked, options.decimals))}
      >
        {(helpers) => (point ? <Marker point={point} helpers={helpers} label="Drag to move" onMove={(moved) => set(round(moved, options.decimals))} /> : null)}
      </SlippyMap>
      <p className="gcms-map-help">{point ? 'Drag the marker or click elsewhere to move it.' : 'Click the map to place a marker, or type or paste coordinates.'}</p>
      <PointControls
        id={props.id}
        value={value}
        decimals={options.decimals}
        inputProps={props.inputProps}
        onChange={(next) => set(next, true)}
        // null, not undefined: react-hook-form shows the default value again for undefined. AutoForm
        // treats null as empty, so an optional field is saved as absent and a required one is flagged.
        onClear={() => field.onChange(null)}
      />
      <NestedErrors name={props.id} />
    </div>
  )
}

/** A point with a range: click to place the center, drag the edge handle or use the slider to resize. */
export function GeoCircleField(props: AutoFormFieldProps) {
  const field = useField(props.id)
  const options = mapOptions(props)
  const value = (field.value ?? undefined) as Partial<GeoCircle> | undefined
  const circle = isGeoPoint(value) && Number.isFinite((value as Partial<GeoCircle>).radius) ? (value as GeoCircle) : undefined
  const [view, setView] = useMapView(circle ? [circle] : isGeoPoint(value) ? [value] : [], options, circle?.radius)

  const min = options.minRadius ?? 0
  const max = options.maxRadius
  const clampRadius = (radius: number) => Math.round(Math.min(max ?? Infinity, Math.max(min, radius)))
  const defaultRadius = clampRadius(options.defaultRadius ?? 1000)

  const set = (next: Partial<GeoCircle>) => field.onChange(next)
  const place = (point: GeoPoint) => set({ ...round(point, options.decimals), radius: value?.radius ?? defaultRadius })

  return (
    <div className="gcms-geo" tabIndex={-1} ref={field.ref as never}>
      <SlippyMap
        view={view}
        onViewChange={setView}
        tiles={options.tiles}
        height={options.height}
        label={typeof props.label === 'string' ? props.label : 'Map'}
        onMapClick={place}
      >
        {(helpers) => {
          if (!circle) return null
          const center = helpers.toPixel(circle)
          const radiusPixels = circle.radius / metersPerPixel(circle.lat, helpers.view.zoom)
          const handle = destination(circle, circle.radius, 90)
          return (
            <>
              <circle className="gcms-map-shape" cx={center.x} cy={center.y} r={Math.max(radiusPixels, 1)} />
              <Marker point={circle} helpers={helpers} label="Drag to move the center" onMove={(moved) => set({ ...round(moved, options.decimals), radius: circle.radius })} />
              <Vertex point={handle} helpers={helpers} label="Drag to change the radius" onMove={(moved) => set({ ...circle, radius: clampRadius(distance(circle, moved)) })} />
            </>
          )
        }}
      </SlippyMap>
      <p className="gcms-map-help">
        {circle ? 'Drag the marker to move the center, or the handle on the edge to change the radius.' : 'Click the map to place the center.'}
      </p>
      <PointControls
        id={props.id}
        value={value}
        decimals={options.decimals}
        inputProps={props.inputProps}
        onChange={(next) => set({ radius: defaultRadius, ...value, ...next })}
        onClear={() => field.onChange(null)}
      >
        <NumberInput id={`${props.id}-radius`} label="Radius (m)" value={value?.radius} onChange={(radius) => set({ ...value, radius })} />
      </PointControls>
      {max !== undefined && value?.radius !== undefined ? (
        <input
          type="range"
          className="gcms-map-range"
          aria-label="Radius"
          min={min}
          max={max}
          step={Math.max(1, Math.round((max - min) / 200))}
          value={value.radius}
          onChange={(event) => set({ ...value, radius: Number(event.target.value) })}
        />
      ) : null}
      {circle ? <p className="gcms-map-help">Radius {formatDistance(circle.radius)}</p> : null}
      <NestedErrors name={props.id} />
    </div>
  )
}

function GeoShapeField(props: AutoFormFieldProps & { closed: boolean }) {
  const field = useField(props.id)
  const options = mapOptions(props)
  const points: Array<Partial<GeoPoint>> = Array.isArray(field.value) ? field.value : []
  const complete = points.filter(isGeoPoint)
  const [view, setView] = useMapView(complete, options)
  const max = options.maxPoints
  const full = max !== undefined && points.length >= max

  const set = (next: Array<Partial<GeoPoint>>) => field.onChange(next)
  const update = (index: number, point: Partial<GeoPoint>) => set(points.map((current, at) => (at === index ? point : current)))
  const remove = (index: number) => set(points.filter((_, at) => at !== index))
  const noun = props.closed ? 'corner' : 'point'

  return (
    <div className="gcms-geo" tabIndex={-1} ref={field.ref as never}>
      <SlippyMap
        view={view}
        onViewChange={setView}
        tiles={options.tiles}
        height={options.height}
        label={typeof props.label === 'string' ? props.label : 'Map'}
        onMapClick={full ? undefined : (point) => set([...points, round(point, options.decimals)])}
      >
        {(helpers) => {
          const pixels = complete.map((point) => helpers.toPixel(point))
          const path = pixels.map((pixel) => `${pixel.x},${pixel.y}`).join(' ')
          return (
            <>
              {pixels.length > 1 ? (
                props.closed ? <polygon className="gcms-map-shape" points={path} /> : <polyline className="gcms-map-shape gcms-map-line" points={path} />
              ) : null}
              {points.map((point, index) =>
                isGeoPoint(point) ? (
                  <Vertex
                    key={index}
                    point={point}
                    helpers={helpers}
                    label={`${noun} ${index + 1}: drag to move`}
                    onMove={(moved) => update(index, round(moved, options.decimals))}
                  />
                ) : null,
              )}
            </>
          )
        }}
      </SlippyMap>
      <p className="gcms-map-help">
        {full ? `The maximum of ${max} ${noun}s is reached.` : `Click the map to add a ${noun}; drag ${noun}s to move them.`}{' '}
        {complete.length > 1
          ? props.closed && complete.length > 2
            ? `Area ${formatArea(polygonArea(complete))}, perimeter ${formatDistance(pathLength([...complete, complete[0]]))}.`
            : `Length ${formatDistance(pathLength(complete))}.`
          : ''}
      </p>
      <div className="gcms-map-actions">
        <button type="button" className="gcms-button gcms-button--small" disabled={points.length === 0} onClick={() => set(points.slice(0, -1))}>
          Remove last {noun}
        </button>
        <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" disabled={points.length === 0} onClick={() => set([])}>
          Clear
        </button>
      </div>
      <details className="gcms-map-points">
        <summary>
          {points.length} {noun}
          {points.length === 1 ? '' : 's'}
        </summary>
        <ol>
          {points.map((point, index) => (
            <li key={index}>
              <NumberInput
                id={index === 0 ? props.id : undefined}
                label="Lat"
                value={point.lat}
                onChange={(lat) => update(index, { ...point, lat })}
                onPastePair={(pair) => update(index, round(pair, options.decimals))}
              />
              <NumberInput label="Lng" value={point.lng} onChange={(lng) => update(index, { ...point, lng })} onPastePair={(pair) => update(index, round(pair, options.decimals))} />
              <button type="button" className="gcms-button gcms-button--ghost gcms-button--small" aria-label={`Remove ${noun} ${index + 1}`} onClick={() => remove(index)}>
                Remove
              </button>
            </li>
          ))}
        </ol>
        {full ? null : (
          <button type="button" className="gcms-button gcms-button--small" onClick={() => set([...points, { ...round(view.center, options.decimals) }])}>
            Add {noun} at map center
          </button>
        )}
      </details>
      <NestedErrors name={props.id} />
    </div>
  )
}

/** A path, such as a route: click to add points, drag them to move. */
export function GeoLineField(props: AutoFormFieldProps) {
  return <GeoShapeField {...props} closed={false} />
}

/** An area: click to add corners, drag them to move. */
export function GeoPolygonField(props: AutoFormFieldProps) {
  return <GeoShapeField {...props} closed />
}
