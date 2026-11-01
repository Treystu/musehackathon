/**
 * Decoding the baked map assets.
 *
 * The centroid file is quantised uint16 coordinate pairs rather than JSON,
 * because a JSON array of 33,791 points is 0.8 MB against ~180 KB packed and
 * the positional error is under six metres, far narrower than any ZIP area.
 *
 * The ZCTA codes are stored as varint deltas rather than implied by position.
 * An earlier version assumed the n-th point was ZCTA n, which silently attaches
 * every point to the wrong ZIP if even one code is ever filtered out — the map
 * would look correct and be wrong, which is the worst failure mode available.
 * Storing the codes makes the mapping exact regardless of what was dropped.
 *
 * Layout: uint32 count, then per point a varint ZCTA delta and two uint16
 * coordinates. `tools/gen-map-data.mjs` writes it; `map-data.test.ts` pins the
 * two against each other.
 */

/** Must match the packing constants in tools/gen-map-data.mjs. */
export const LON_MIN = -180
export const LAT_MIN = -20
export const LON_MAX = 180
export const LAT_MAX = 75

const SCALE_X = 65535 / (LON_MAX - LON_MIN)
const SCALE_Y = 65535 / (LAT_MAX - LAT_MIN)

export interface ZctaPoint {
  zcta: string
  lon: number
  lat: number
}

/** Reads a LEB128-style unsigned varint, as written by the packer. */
function readVarint(view: DataView, offset: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  let at = offset
  // Bounded so a corrupt file cannot spin here forever.
  for (let i = 0; i < 5 && at < view.byteLength; i++) {
    const byte = view.getUint8(at++)
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, next: at }
    shift += 7
  }
  return { value, next: at }
}

/**
 * Expands the packed file into points. Malformed input yields the points read so
 * far rather than throwing, because this runs inside a render.
 */
export function decodeCentroids(buffer: ArrayBuffer): ZctaPoint[] {
  if (buffer.byteLength < 8) return []
  const view = new DataView(buffer)
  const count = view.getUint32(0, false)
  if (count === 0) return []

  const out: ZctaPoint[] = []
  let offset = 4
  let previousZcta = -1

  for (let i = 0; i < count; i++) {
    if (offset + 5 > view.byteLength) break
    const { value: delta, next } = readVarint(view, offset)
    offset = next
    if (offset + 4 > view.byteLength) break
    const lon = LON_MIN + view.getUint16(offset, false) / SCALE_X
    const lat = LAT_MIN + view.getUint16(offset + 2, false) / SCALE_Y
    offset += 4
    const zcta = previousZcta + delta + 1
    previousZcta = zcta
    out.push({ zcta: String(zcta).padStart(5, '0'), lon, lat })
  }
  return out
}

/** Bakes a point set back into the packed format. Used by tests, not at runtime. */
export function encodeCentroids(points: readonly ZctaPoint[]): ArrayBuffer {
  const sorted = [...points].sort((a, b) => Number(a.zcta) - Number(b.zcta))
  const parts: number[] = []
  let previous = -1
  sorted.forEach((p) => {
    const zcta = Number(p.zcta)
    let value = zcta - previous - 1
    if (value < 0) throw new Error('ZCTA codes must be unique and ascending')
    previous = zcta
    // Interleaved with the coordinates, matching the reader: a varint, then this
    // point's two uint16s. Writing all varints first and all coordinates after
    // would still round-trip, but only if both sides were changed together.
    do {
      const byte = value & 0x7f
      value >>>= 7
      parts.push(value > 0 ? byte | 0x80 : byte)
    } while (value > 0)

    const lo = Math.max(0, Math.min(65535, Math.round((p.lon - LON_MIN) * SCALE_X)))
    const la = Math.max(0, Math.min(65535, Math.round((p.lat - LAT_MIN) * SCALE_Y)))
    parts.push((lo >> 8) & 0xff, lo & 0xff, (la >> 8) & 0xff, la & 0xff)
  })

  // `parts` already contains every byte after the count, varints included.
  const buffer = new ArrayBuffer(4 + parts.length)
  const view = new DataView(buffer)
  view.setUint32(0, sorted.length, false)
  parts.forEach((b, i) => view.setUint8(4 + i, b))
  return buffer
}
