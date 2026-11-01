/**
 * Relative luminance of a hex colour, by the WCAG formula.
 *
 * Needed because the ramp now runs light to dark: a fixed label colour would be
 * dark-on-dark over exactly the hexagons that matter most, which are the high
 * values. Anything above roughly 0.45 takes white text.
 */
function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return true
  const n = parseInt(m[1]!, 16)
  const channel = (c: number) => {
    const srgb = c / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  const l = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  return l > 0.32
}

/** Below this zoom, hexagons are too small and too many to letter. */
const LABEL_MIN_SCALE = 2.6
/** Labels are pointless in a hexagon smaller than this. */
const LABEL_MIN_RADIUS = 11

/** Three strokes, enough to read as an asterisk at ten pixels. */
const ASTERISK_STROKES: readonly [number, number][] = [
  [-1, -1],
  [0, 1],
  [1, -1],
]

/**
 * The map view.
 *
 * Canvas 2D, no tile server, no map framework. That is a deliberate choice
 * rather than a simplification: a tile-based map would mean a third-party origin
 * in the Content-Security-Policy, a runtime dependency on someone else's
 * uptime, and a request log for every visitor. All this needs is 33,791
 * positions the app already has numbers for, and those are baked into a
 * 165 KB file served from the same origin.
 *
 * Accessibility drives one thing above all: a canvas is invisible to a screen
 * reader. So the map is presented as a *visual* view of the same data, with the
 * screening table remaining the accessible path to every figure, and the legend
 * spelled out in text rather than in colour swatches alone. Nothing on this
 * surface can be the only way to reach a number.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { hexbin, hexRadius, HEX_CORNERS, type BinInput } from '../core/map/binning'
import {
  loadMapAssets,
  fitBase,
  projectAll,
  screenTransform,
  buildOutlinePath,
  type Basemap,
} from '../core/map/projection'
import type { ZctaPoint } from '../core/map/centroids'
import {
  buildBins,
  binFor,
  formatValue,
  MAP_METRICS,
  NO_DATA_COLOR,
  NO_DATA_LABEL,
  type MapMetricKey,
} from '../core/map/scale'
import type { AreaRow } from '../core/plugins/acs'
import type { MuseProvider } from '../core/ai/provider'
import { FairHousingNotice } from './FairHousingNotice'
import { ExplainAction } from './ai/ExplainAction'
import { figureInputsFromAreaRows } from './ai/figure-input'
import { useMapCanvasInteractions, useMapViewport } from './map-interactions'

interface Props {
  rows: readonly AreaRow[]
  /** True while the country-wide sweep is still fetching. */
  loading: boolean
  onSelect: (zctas: string[]) => void
  /** Areas already in the comparison set, outlined on the map. */
  selectedZctas: readonly string[]
  explainProvider?: MuseProvider
}

export function MapView({ rows, loading, onSelect, selectedZctas, explainProvider }: Props) {
  const headingId = useId()
  const legendId = useId()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const [metric, setMetric] = useState<MapMetricKey>('median_rent_burden_pct')
  const [assets, setAssets] = useState<{ centroids: ZctaPoint[]; basemap: Basemap | null } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { viewport, setViewport, setWidth, zoomAtData, reset } = useMapViewport()

  const active = MAP_METRICS.find((m) => m.key === metric) ?? MAP_METRICS[0]!
  const unit = active.unit

  /*
   * Values by ZIP, so a point and its figure are looked up the same way.
   *
   * A derived figure is computed here rather than upstream, which is why it
   * costs nothing: the components are already cached, and a ratio that cannot
   * be formed is null rather than a guess, so it renders as not yet imported
   * exactly like a genuinely missing estimate does.
   */
  const valueByZcta = useMemo(() => {
    const m = new Map<string, number | null>()
    const derive = active.derive
    for (const row of rows) {
      m.set(row.zcta, derive ? derive(row.metrics) : (row.metrics[metric] ?? null))
    }
    return m
  }, [rows, metric, active])

  const bins = useMemo(
    () => buildBins([...valueByZcta.values()].filter((v): v is number => v !== null)),
    [valueByZcta],
  )

  useEffect(() => {
    const controller = new AbortController()
    loadMapAssets(controller.signal)
      .then(setAssets)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setLoadError(err instanceof Error ? err.message : 'the map could not be loaded')
      })
    return () => controller.abort()
  }, [])

  /*
   * Match the backing store to the CSS box, so the map is not blurry on a
   * high-DPI screen.
   *
   * Only the width is observed. The wrapper's height is whatever the canvas
   * makes it, so writing the canvas height from state and then measuring the
   * wrapper height is a feedback loop: the map grew fourteen pixels on every
   * pass, forever, dragging everything below it down the page and repainting
   * about twenty-two thousand times a second. The height is fixed by CSS and
   * never written back.
   */
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const observer = new ResizeObserver(() => {
      const width = Math.round(wrap.getBoundingClientRect().width)
      setWidth(width)
    })
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [setWidth])

  // The fit is computed once when the assets arrive, not per frame: it
  // projects all 33,791 positions, and recomputing it on every pan or zoom
  // would make dragging the map janky for no benefit.
  const fit = useMemo(() => (assets ? fitBase(assets.centroids) : null), [assets])

  /*
   * Projected positions, computed once.
   *
   * The projection is held at its fitted scale and zoom is applied afterwards,
   * so these numbers do not change when the reader zooms or pans. Recomputing
   * 33,791 projections on every frame was the cost that made a zoom click take
   * about a second; here it is paid once, on load.
   */
  const projected = useMemo(() => {
    if (!assets || !fit) return null
    return projectAll(fit, assets.centroids)
  }, [assets, fit])

  // Traced once per projection, then re-stroked under the viewport transform,
  // so the outlines cost one stroke() per repaint rather than re-walking every
  // state boundary through the path builder.
  const outlinePath = useMemo(
    () => (fit ? buildOutlinePath(assets?.basemap ?? null, fit) : null),
    [assets, fit],
  )

  const geoms = useMemo(() => {
    if (!assets || !fit || !projected) return []
    const radius = hexRadius(viewport.scale)
    const { s, ox, oy } = screenTransform(viewport)
    const inputs: BinInput[] = []
    const pad = radius * 2
    for (let i = 0; i < projected.ok.length; i++) {
      if (!projected.ok[i]) continue
      const x = projected.xs[i]! * s + ox
      const y = projected.ys[i]! * s + oy
      // Cull off-screen work before it reaches the binner.
      if (x < -pad || x > viewport.width + pad || y < -pad || y > viewport.height + pad) continue
      const zcta = assets.centroids[i]!.zcta
      const value = valueByZcta.get(zcta)
      // A point with no usable figure is kept, so it renders as explicitly
      // absent rather than quietly vanishing from the map.
      inputs.push({
        x,
        y,
        value: value === null || value === undefined ? Number.NaN : value,
        zctas: [zcta],
      })
    }
    return hexbin(inputs, radius)
  }, [assets, fit, projected, viewport, valueByZcta])

  const {
    hover,
    onKeyDown,
    onMouseMove,
    onMouseLeave,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClick,
  } = useMapCanvasInteractions({ canvasRef, geoms, viewport, setViewport, onSelect })

  // Canvas has no accessibility tree, so an equivalent is published as live
  // text. A screen-reader user gets the bins, not silence.
  const summary = useMemo(() => {
    const shown = geoms.length
    const withValue = geoms.filter((g) => g.value !== null).length
    const single = geoms.filter((g) => g.count === 1).length
    if (shown === 0) return 'The map has not drawn any areas yet.'
    return (
      `The map shows ${shown.toLocaleString('en-US')} areas. ` +
      `${withValue.toLocaleString('en-US')} have a ${MAP_METRICS.find((m) => m.key === metric)?.label} figure. ` +
      `${single.toLocaleString('en-US')} of them cover exactly one ZIP code, where the figure shown is that ZIP ` +
      `code's own published value rather than a median across several. ` +
      `Every figure is also listed in the screening table.`
    )
  }, [geoms, metric])


  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !assets || !fit) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const backingW = Math.round(viewport.width * dpr)
    const backingH = Math.round(viewport.height * dpr)
    // The backing store is resized only when it actually differs. Assigning it
    // clears the canvas, so doing it unconditionally meant every repaint wiped
    // the map and drew it again, and the assignment itself was what drove the
    // layout churn.
    if (canvas.width !== backingW) canvas.width = backingW
    if (canvas.height !== backingH) canvas.height = backingH
    // The displayed size is left entirely to CSS. Writing it here is what fed
    // the ResizeObserver loop.
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, viewport.width, viewport.height)

    const radius = hexRadius(viewport.scale)

    // Basemap first, so data sits on top of it.
    if (outlinePath) {
      ctx.strokeStyle = '#cbd5e1'
      ctx.lineWidth = 1
      outlinePath(viewport)(ctx)
    }

    /*
     * Hexagons, then labels on top of them.
     *
     * These are one loop rather than two because a label's ink has to be chosen
     * from its own hexagon's fill, and splitting them meant recomputing the
     * colour and luminance for every cell a second time.
     *
     * The ramp runs light for low values to dark for high, so the eye is drawn
     * to the high end the way it is on every map a reader has seen before.
     * Both the separating hairline and the label ink therefore follow each
     * fill's luminance: a fixed white hairline vanishes against the dark end,
     * which is the end that matters most.
     */
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const labelling = radius >= LABEL_MIN_RADIUS
    for (const bin of geoms) {
      // A cell with no figure at all is left undrawn rather than painted grey.
      // The empty space IS the information — a grey hexagon read as a failure,
      // and painting a placeholder implied data existed where none did.
      if (bin.value === null) continue
      const r = radius
      const isSelected = bin.zctas.some((z) => selectedZctas.includes(z))
      const color = binFor(bins, bin.value)?.color ?? NO_DATA_COLOR
      ctx.beginPath()
      HEX_CORNERS.forEach(([dx, dy], i) => {
        const x = bin.cx + dx * r
        const y = bin.cy + dy * r
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()

      const pale = isLight(color)
      ctx.strokeStyle = isSelected ? '#0f172a' : pale ? '#ffffff' : 'rgba(255,255,255,0.32)'
      ctx.lineWidth = isSelected ? 2.5 : 0.75
      ctx.stroke()

      /*
       * A small asterisk marks a hexagon whose ZIP codes are only partly
       * loaded, so its figure is the median of what has arrived rather than of
       * everything. The data is shown rather than withheld; this says plainly
       * that more is still coming for this particular cell.
       */
      if (loading && bin.value !== null && bin.withValue < bin.count) {
        const mark = r * 0.3
        ctx.beginPath()
        ctx.lineWidth = 1.25
        ctx.strokeStyle = pale ? 'rgba(15,23,42,0.75)' : 'rgba(255,255,255,0.9)'
        for (const [dx, dy] of ASTERISK_STROKES) {
          ctx.moveTo(bin.cx + dx * mark - mark * 0.5, bin.cy + dy * mark - mark * 0.5)
          ctx.lineTo(bin.cx + dx * mark + mark * 0.5, bin.cy + dy * mark + mark * 0.5)
        }
        ctx.stroke()
      }
      ctx.stroke()

      if (!labelling) continue
      if (bin.count !== 1 && viewport.scale < LABEL_MIN_SCALE) continue
      const text = bin.count === 1 ? bin.zctas[0]! : String(bin.count)
      ctx.font = `${Math.max(9, Math.min(13, r * 0.62))}px ui-monospace, monospace`
      // Skip anything that would not fit its own hexagon, which is what stops a
      // dense area turning into an unreadable smear of letters.
      if (ctx.measureText(text).width > r * 1.75) continue
      ctx.lineWidth = 2.5
      ctx.strokeStyle = pale ? 'rgba(255,255,255,0.9)' : 'rgba(15,23,42,0.55)'
      ctx.strokeText(text, bin.cx, bin.cy)
      ctx.fillStyle = pale ? '#0f172a' : '#ffffff'
      ctx.fillText(text, bin.cx, bin.cy)
    }
  }, [assets, fit, viewport, geoms, bins, selectedZctas, outlinePath])

  useEffect(() => {
    draw()
  }, [draw])

  const covered = useMemo(() => geoms.filter((g) => g.value !== null).length, [geoms])

  return (
    <section aria-labelledby={headingId} className="mt-8 panel panel-padded">
      <h2 id={headingId} className="section-title">
        Map
      </h2>
      <p className="section-note mt-1">
        One hexagon per area, coloured by the selected figure. Each hexagon covers one or more ZIP codes and
        shows the median of the ZIP codes inside it that have a figure. Zoom in and the hexagons separate: at the deepest zoom each one holds a single ZIP code and shows that ZIP code's own published figure unaltered, because a median across many ZIP codes is a figure that exists nowhere in the data. Point at a hexagon to see how many ZIP codes it covers. Every figure is also in the screening table, which is the accessible way to read this data.
      </p>

      <fieldset className="mt-3">
        <legend className="text-sm font-semibold text-slate-900">What the colour shows</legend>
        <p className="mt-1 max-w-3xl text-[0.8125rem] leading-snug text-slate-600">
          One list, one meaning. <strong className="text-slate-900">Darker always means a higher number</strong>,
          for every figure on this map. The full explanation for each one appears on hover.
        </p>
        <ul className="mt-2 space-y-1">
          {MAP_METRICS.map((m) => (
            <li key={m.key}>
              <label
                className={`flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-[0.8125rem] transition-colors hover:bg-slate-100 ${
                  metric === m.key ? 'bg-slate-100 ring-1 ring-slate-300' : ''
                }`}
                title={m.blurb}
              >
                <input
                  type="radio"
                  name={`map-metric-${headingId}`}
                  value={m.key}
                  checked={metric === m.key}
                  onChange={() => setMetric(m.key)}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={`mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full border ${
                    metric === m.key ? 'border-slate-900 bg-slate-900' : 'border-slate-400 bg-white'
                  }`}
                />
                <span className="font-medium text-slate-900">{m.label}</span>
                <span className="text-slate-600">
                  darker = higher
                  {m.unit === 'ratio' ? ' (a multiple, e.g. 4.5x)' : ''}
                </span>
              </label>
            </li>
          ))}
        </ul></fieldset>

      {loadError ? (
        <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          The map could not be drawn: {loadError}. The screening table below still shows every figure.
        </p>
      ) : null}

      <div
        ref={wrapRef}
        className="relative mt-3 overflow-hidden panel"
      >
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="img"
          aria-labelledby={`${headingId} ${legendId}`}
          onKeyDown={onKeyDown}
          style={{ touchAction: 'pan-y' }}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onClick={onClick}
          className="block h-[560px] w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
        />
        {hover ? (
          <div
            className="pointer-events-none absolute z-10 max-w-xs rounded-md border border-slate-300 bg-white p-2 text-xs shadow-sm"
            style={{
              left: Math.min(hover.cx + 12, viewport.width - 180),
              top: Math.min(hover.cy + 12, viewport.height - 90),
            }}
          >
            <p className="font-semibold text-slate-900">
              {hover.value === null
                ? NO_DATA_LABEL
                : formatValue(hover.value, unit)}
            </p>
            <p className="text-slate-700">
              {hover.count === 1 ? hover.zctas[0] : `${hover.count} ZIP codes`}
              {hover.withValue < hover.count
                ? `, ${hover.withValue} with a figure`
                : ''}
            </p>
            {/*
              The word that answers the question this hover provokes. A hexagon
              shows the MEDIAN of the ZIP codes inside it that carry a figure —
              not their sum, not their mean — so one extreme area cannot dominate
              its neighbours. That design decision was documented in the legend
              and in the screen-reader text, but not here, until a reader asked
              why the map showed 45 for five areas whose household figures are
              9, 30, 45, 64 and 2,086: the answer is that 45 IS the median, and
              the hover owed them the word.
            */}
            {hover.count > 1 && hover.withValue > 1 && hover.value !== null ? (
              <p className="text-slate-600">Median of the {hover.withValue} with a figure, not a sum or average.</p>
            ) : null}
            {hover.zctas.length <= 4 ? (
              <p className="text-slate-600">{hover.zctas.join(', ')}</p>
            ) : null}
          </div>
        ) : null}
{/*
          Pointer affordances. Zoom was previously reachable only from the
          keyboard, which is fine for accessibility and useless for anyone
          using a mouse or a touchscreen, so the same three actions are offered
          as buttons.
        */}
        <div className="absolute right-2 top-2 flex flex-col gap-1 rounded-lg border border-slate-200 bg-white/90 p-1 shadow-sm backdrop-blur">
          <button
            type="button"
            onClick={() => zoomAtData(geoms, 1.5)}
            aria-label="Zoom in"
            className="h-7 w-7 rounded-md text-lg leading-none text-slate-700 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
          >
            <span aria-hidden="true">+</span>
          </button>
          <button
            type="button"
            onClick={() => zoomAtData(geoms, 1 / 1.5)}
            aria-label="Zoom out"
            className="h-7 w-7 rounded-md text-lg leading-none text-slate-700 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
          >
            <span aria-hidden="true">&minus;</span>
          </button>
          <button
            type="button"
            onClick={reset}
            aria-label="Reset the map to the whole country"
            className="h-7 w-7 rounded-md text-xs leading-none text-slate-700 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
          >
            <span aria-hidden="true">&#8634;</span>
          </button>
        </div>
        <p className="pointer-events-none absolute bottom-2 left-2 max-w-[22rem] rounded bg-white/85 px-2 py-1 text-[11px] leading-snug text-slate-600 backdrop-blur">
          Drag to pan, scroll or pinch to zoom, or use the buttons. Arrow keys pan, + and &minus; zoom, 0
          resets. Click an area to compare it.
        </p>
      </div>

      {/* The legend is real text, not swatches alone, so the scale is readable
          without colour perception. */}
      <div id={legendId} className="mt-2 text-sm">
        <p className="font-semibold text-slate-900">
          Legend — {active?.label}
          {bins.length === 0 ? ' (no figures loaded yet)' : ''}
        </p>
        {bins.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[0.8125rem] text-slate-700">
            {bins.map((bin) => (
              <li key={bin.color} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-3 w-3 rounded-sm border border-white"
                  style={{ backgroundColor: bin.color }}
                />
                {formatValue(bin.from, unit)} to {bin.to === null ? 'the highest' : formatValue(bin.to, unit)}
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded-sm border border-white"
                style={{ backgroundColor: NO_DATA_COLOR }}
              />
              {NO_DATA_LABEL}
            </li>
          </ul>
        ) : null}
        <p className="mt-1 text-[0.8125rem] leading-snug text-slate-600">
          {loading
            ? 'Still loading. An asterisk marks a hexagon whose ZIP codes are only partly loaded, so its figure is the median of what has arrived so far rather than of everything.'
            : `Loaded ${covered.toLocaleString('en-US')} of ${geoms.length.toLocaleString('en-US')} areas with a figure. Every figure the Census Bureau publishes has been loaded and is shown; areas left blank have no figure published at all, which is the publisher's answer rather than a loading failure.`}{' '}
          Alaska, Hawaii and Puerto Rico are drawn as insets.
        </p>
      </div>

      {explainProvider && selectedZctas.length > 0 && (
        <div className="mt-3">
          <ExplainAction
            title="the selected map figures"
            figureSetId="map-selection"
            figures={figureInputsFromAreaRows(rows, selectedZctas, [metric])}
            provider={explainProvider}
          />
        </div>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {summary}
      </p>

      {/*
        Schools, and why this map does not rank them.
        
        District staffing and enrollment figures exist for selected areas in all
        states. A separate national source joins 2019 EDFacts four-year graduation
        outcomes to 2019–20 public-school locations; up to eight nearest schools
        within 3 km with a reportable outcome appear. NYC DOE also supplies named-school
        enrollment, graduation and attendance from its separate 2018–19 directory.

        This map does not turn school measures into a quality score or combine
        them with housing costs into a "best schools for the price" result. That
        is a product boundary: these measures describe different things and do
        not establish which place is right for a reader. It is not a claim that
        publishing school information is inherently unlawful.
      */}
      <details className="mt-3 rounded-lg border border-slate-200 bg-white">
        <summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-semibold text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900">
          Schools: current coverage and why there is no combined score
        </summary>
        <div className="border-t border-slate-200 px-3 py-2.5 text-[0.8125rem] leading-relaxed text-slate-700">
          <p>
            <strong className="text-slate-900">Every area, all 50 states:</strong> the school district covering
            it, with teacher count, students per teacher, enrolled students and school count.
            Open any area from the map or the table and these appear.
          </p>
          <p className="mt-2">
            <strong className="text-slate-900">Nationwide, with limits:</strong> up to eight nearest public
            schools within 3 km with a reportable 2019 four-year adjusted cohort graduation outcome. The
            displayed figure is the Urban Institute Portal&rsquo;s midpoint and many records also have a published
            range. Schools with missing, not-applicable, or suppressed outcomes are omitted; this does not cover
            all grades, years, or types of school outcome.
          </p>
          <p className="mt-2">
            <strong className="text-slate-900">New York City:</strong> its separate DOE directory also gives
            nearby school enrolment, graduation and attendance from the 2018–19 school year.
          </p>
          <p className="mt-2">
            <strong className="text-slate-900">Why there is no &ldquo;best schools for the price&rdquo;
            score.</strong> School measures describe different things and do not establish school quality.
            We show the available source figures without combining them with housing costs or recommending
            a place. This is a product boundary, not a claim that publishing school information is inherently
            unlawful.
          </p>
          <p className="mt-2">
            Spending per pupil is a cost of provision, not a measure of quality. It varies with local budgets
            and cost of living, and two districts spending the same per student can teach very differently.
          </p>
        </div>
      </details>

      <div className="mt-4">
        <FairHousingNotice />
      </div>
    </section>
  )
}
