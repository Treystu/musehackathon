/**
 * Turning 33,791 individual ZIP positions into something readable.
 *
 * Drawing one dot per ZIP works until it does not. At national zoom the whole
 * east coast is a single overlapping mass and the map is unreadable, which is
 * the same problem a proportional-symbol map has.
 *
 * A hexagonal bin solves it: ZIPs are grouped into hexagons of roughly equal
 * screen size, and each hexagon reports a statistic of the ZIPs inside it. One
 * hexagon is one position on the map, so the result scales with the viewport
 * rather than with the data.
 *
 * The statistic is the **median**, deliberately. A mean of household income
 * across a hexagon is dominated by whichever extreme ZIP happens to fall in it,
 * so zooming around the map would make the same area change value for no
 * reason. A median is stable under that.
 *
 * The count is also reported, because a hexagon covering one rural ZIP is not
 * the same claim as one covering four hundred, and a map that hides that
 * difference overstates how much the country is sampled.
 */

export interface BinInput {
  x: number
  y: number
  value: number
  zctas: string[]
}

export interface HexBin {
  /** Hexagon centre in canvas pixels. */
  cx: number
  cy: number
  /** Median of the values inside, or null when too few were usable. */
  value: number | null
  /** How many ZIP codes the hexagon covers. */
  count: number
  /** How many of those actually had a figure. */
  withValue: number
  zctas: string[]
}

/**
 * Hexagon radius in screen pixels.
 *
 * This used to be a constant, which is what made the map feel unfinished:
 * zooming in enlarged the whole projection but left every hexagon at nine
 * pixels, so the extra magnification bought nothing and the country just grew.
 * The radius now scales with the viewport so that zooming in genuinely resolves
 * finer detail — at high zoom a hexagon holds a handful of ZIP codes and the
 * reader is looking at neighbourhoods rather than the country.
 */
export function hexRadius(viewportScale: number): number {
  // Clamped at the small end only. Below about 5px the hexagons cannot hold a
  // legible tooltip and the fill starts to disappear between neighbours. The
  // upper bound was 26px, which capped the detail the map could ever resolve;
  // at deep zoom the hexagons have to keep growing so they can shrink their
  // membership down to a single ZIP code.
  const r = 9 * Math.pow(Math.max(1, viewportScale), 0.55)
  return Math.max(5, r)
}

/**
 * The share of a hexagon's ZIP codes that must carry a figure before its median
 * is shown.
 *
 * Requiring all of them was defensible and useless: with roughly eighteen ZIP
 * codes to a hexagon, a single missing estimate greyed the whole cell, and only
 * about one hexagon in seven was ever coloured. Requiring none of them would be
 * worse, because a hexagon covering one rural ZIP with data and twenty without
 * would confidently claim a value for a mostly-empty area. A majority is the
 * point where the cell is genuinely representative, and the coverage is
 * disclosed in the tooltip and the legend so the reader can judge it.
 */
/**
 * Shown beside a hexagon whose ZIP codes are only partly loaded.
 *
 * A hexagon used to be greyed unless at least half its ZIP codes carried a
 * figure, on the reasoning that a median over mostly-missing data misleads. The
 * effect was that a quarter of the country simply had no colour, and a reader
 * could not tell a sparse rural area from one whose data had not finished
 * arriving. Greying hid data that was genuinely there.
 *
 * The value is now reported from whatever has loaded, and partial coverage is
 * marked rather than suppressed.
 */
function median(sorted: readonly number[]): number {
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/**
 * Groups points into hexagons of the given screen radius.
 *
 * Row offsets alternate by half a hexagon so rows interlock, which is what stops
 * the gaps forming visible stripes. Bins whose members lack a figure still
 * appear, carrying `value: null`, because a hexagon that silently disappears
 * looks identical to one that was never there.
 */
export function hexbin(inputs: readonly BinInput[], radius = 9): HexBin[] {
  if (inputs.length === 0) return []

  const rowHeight = Math.round(radius * 1.5)
  const colWidth = Math.round(Math.sqrt(3) * radius)

  const buckets = new Map<string, { values: number[]; zctas: string[]; sx: number; sy: number }>()
  for (const input of inputs) {
    const row = Math.round(input.y / rowHeight)
    const offset = row % 2 === 0 ? 0 : colWidth / 2
    const col = Math.round((input.x - offset) / colWidth)
    const key = `${row}:${col}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { values: [], zctas: [], sx: 0, sy: 0 }
      buckets.set(key, bucket)
    }
    if (Number.isFinite(input.value)) bucket.values.push(input.value)
    bucket.zctas.push(...input.zctas)
    bucket.sx += input.x
    bucket.sy += input.y
  }

  const out: HexBin[] = []
  for (const bucket of buckets.values()) {
    const count = bucket.zctas.length
    if (count === 0) continue
    const withValue = bucket.values.length
    bucket.values.sort((a, b) => a - b)
    out.push({
      cx: bucket.sx / count,
      cy: bucket.sy / count,
      // Reported from whatever has loaded. Null only when nothing has at all.
      value: withValue > 0 ? median(bucket.values) : null,
      count,
      withValue,
      zctas: bucket.zctas.sort(),
    })
  }
  return out
}

/** Hexagon corner offsets, as unit vectors, so the renderer needs no trig. */
export const HEX_CORNERS: readonly [number, number][] = [
  [0, -1],
  [0.866, -0.5],
  [0.866, 0.5],
  [0, 1],
  [-0.866, 0.5],
  [-0.866, -0.5],
]
