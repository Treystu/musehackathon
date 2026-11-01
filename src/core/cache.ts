/**
 * Versioned sweep cache.
 *
 * This is separate from the generic HTTP cache because the sweep has different
 * needs: many medium-sized records that arrive incrementally, must be readable
 * while more are still arriving, and must be invalidated wholesale when the
 * variable set or the data vintage changes.
 *
 * Three properties matter:
 *
 *   1. A version stamp. `acs5:2023:screen:v1` is the key prefix. Change the
 *      vintage or the variable set and the bump invalidates every chunk at
 *      once, so stale numbers can never be shown under a current label.
 *   2. Independent chunks. A failed or skipped chunk leaves a valid partial
 *      result rather than corrupting the whole record.
 *   3. Stale-while-revalidate. Cached data renders immediately and refresh
 *      happens in the background, so a visitor is never blocked on the network
 *      and an expired entry is still better than a blank page.
 *
 * Storage is IndexedDB with an in-memory fallback, because a browser in private
 * mode or with storage disabled must still work, just without persistence.
 */

const DB_NAME = 'civicscope-cache'
const DB_VERSION = 2
const CHUNKS = 'sweep-chunks'
const MANIFEST = 'sweep-manifest'

/** Chunks older than this are served but flagged for background refresh. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** Rough cap on cached sweep rows, to bound storage. */
export const MAX_CACHED_CHUNKS = 200

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: 'key' })
        if (!db.objectStoreNames.contains(MANIFEST)) db.createObjectStore(MANIFEST, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(RESPONSES)) db.createObjectStore(RESPONSES, { keyPath: 'url' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function store<T>(name: string, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const t = db.transaction(name, mode)
          const r = op(t.objectStore(name))
          r.onsuccess = () => resolve(r.result as T)
          r.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

interface ChunkRecord<T> {
  key: string
  version: string
  body: T
  fetchedAt: number
}

export interface CachedChunk<T> {
  body: T
  fetchedAt: number
  isStale: boolean
}

/**
 * The stored key for a chunk at a version.
 *
 * The store's keyPath has always been `key` and the chunk key carries no
 * version, so writing a new version replaced the old record: one chunk could
 * hold exactly one version, every stamp bump discarded every visitor's cache,
 * and "use every version we hold" could not be expressed at all. The version now
 * lives in the key, which needs no schema change.
 */
function composite(chunkKey: string, version: string): string {
  return `${chunkKey}@${version}`
}

function hit<T>(rec: ChunkRecord<T>): CachedChunk<T> {
  return { body: rec.body, fetchedAt: rec.fetchedAt, isStale: Date.now() - rec.fetchedAt > STALE_AFTER_MS }
}

export const sweepCache = {
  async read<T>(key: string, version: string): Promise<CachedChunk<T> | null> {
    // The stored key carries the version, so one chunk can hold several
    // versions instead of the newest replacing the older ones.
    const direct = await store<ChunkRecord<T>>(CHUNKS, 'readonly', (st) => st.get(composite(key, version)))
    if (direct) return hit(direct)

    // A record written before the key carried a version is still valid data, so
    // it is adopted rather than discarded, and re-keyed in place as it is read.
    //
    // This is deliberately a lazy migration rather than a bulk one in
    // `onupgradeneeded`. A bulk rewrite runs inside a versionchange transaction,
    // which has awkward lifetime rules and which three attempts here failed to
    // drive to completion. Reading is ordinary application code, so the same
    // logic cannot break for reasons unrelated to storage. It also cannot lose
    // data: until a record is actually read it keeps its original key, and a
    // failure anywhere leaves the old record exactly where it was.
    const legacy = await store<ChunkRecord<T>>(CHUNKS, 'readonly', (st) => st.get(key))
    if (!legacy || legacy.version !== version) return null
    // A put is returned rather than a bare block because the helper hands the
    // request back, and returning it keeps the transaction alive until the write
    // has actually landed.
    await store(CHUNKS, 'readwrite', (st) =>
      st.put({ ...legacy, key: composite(key, version) } as ChunkRecord<T>),
    )
    await store(CHUNKS, 'readwrite', (st) => st.delete(key))
    return hit(legacy)
  },

  async write<T>(key: string, body: T, version: string): Promise<void> {
    await store(CHUNKS, 'readwrite', (st) =>
      st.put({ key: composite(key, version), version, body, fetchedAt: Date.now() } as ChunkRecord<T>),
    )
  },

  async count(): Promise<number> {
    const n = await store<number>(CHUNKS, 'readonly', (s) => s.count())
    return n ?? 0
  },

  /**
   * Deletes any cached chunk that contains an implausible value.
   *
   * A visitor who loaded the site before the sentinel fix has poisoned rows
   * stored under the old version stamp. Bumping the stamp discards them, but a
   * browser can also hold entries written by a build that shipped the same
   * stamp with different parsing, and a user should never be asked to clear
   * storage by hand to get correct numbers.
   *
   * So the cache is swept on load: anything holding a value that no estimate can
   * take is dropped and re-fetched. This runs once per session and is bounded,
   * so it costs nothing on a healthy cache.
   */
  async purgeImplausible(): Promise<number> {
    const recs = await store<ChunkRecord<unknown>[]>(CHUNKS, 'readonly', (s) => s.getAll())
    if (!recs || recs.length === 0) return 0

    const bad = recs.filter((r) => containsImplausible(r?.body))
    if (bad.length === 0) return 0

    const db = await openDb()
    if (!db) return 0
    try {
      const t = db.transaction(CHUNKS, 'readwrite')
      const store = t.objectStore(CHUNKS)
      for (const r of bad) store.delete(r.key)
      await new Promise<void>((resolve) => {
        t.oncomplete = () => resolve()
        t.onerror = () => resolve()
        t.onabort = () => resolve()
      })
    } catch {
      return 0
    }
    return bad.length
  },

  async clear(): Promise<void> {
    await store(CHUNKS, 'readwrite', (s) => s.clear())
    await store(MANIFEST, 'readwrite', (s) => s.clear())
  },
}

/**
 * True when a cached payload contains a value that cannot be a measurement.
 *
 * Any negative number is impossible for the estimates stored here, and the
 * missing-value encodings are large negatives, so one check covers both without
 * the cache layer needing to know the sentinel values.
 */
export function containsImplausible(body: unknown): boolean {
  // Deliberately narrow. The ACS endpoints really do return negative numbers,
  // but every negative one is a missing-data encoding rather than an estimate,
  // so matching the encodings themselves is precise where rejecting "any
  // negative" would only ever work by coincidence. Verified against the live
  // endpoint: across 228 ZCTAs in four states the only negative values returned
  // were sentinels.
  const SENTINELS = new Set([666666666, -666666666, 999999999, -999999999, 888888888, -888888888])
  const seen = new Set<unknown>()
  const walk = (node: unknown): boolean => {
    if (typeof node === 'number') return !Number.isFinite(node) || SENTINELS.has(node)
    if (node === null || typeof node !== 'object') return false
    if (seen.has(node)) return false
    seen.add(node)
    if (Array.isArray(node)) return node.some(walk)
    return Object.values(node as Record<string, unknown>).some(walk)
  }
  return walk(body)
}

export interface StoredManifest {
  id: string
  version: string
  [k: string]: unknown
}

/**
 * The manifest is stored so a reload can render the previous result immediately,
 * before deciding what still needs fetching. Without it, every reload would
 * start from an empty table.
 */
export const manifestStore = {
  async read<T extends object>(id: string, version: string): Promise<{ data: T; fetchedAt: number } | null> {
    const rec = await store<{ id: string; version: string; data: T; fetchedAt: number }>(
      MANIFEST,
      'readonly',
      (s) => s.get(id),
    )
    if (!rec || rec.version !== version) return null
    return { data: rec.data, fetchedAt: rec.fetchedAt }
  },

  async write<T extends object>(id: string, version: string, data: T): Promise<void> {
    await store(MANIFEST, 'readwrite', (s) => s.put({ id, version, data, fetchedAt: Date.now() }))
  },
}

/** Human-readable cache state for the cache panel. */
export async function cacheStatus(): Promise<{ chunks: number; approxRows: number }> {
  const chunks = await sweepCache.count()
  // Row count is not stored separately to keep writes small; the manifest
  // carries the authoritative figure when present.
  return { chunks, approxRows: chunks * 1000 }
}

// ---------------------------------------------------------------------------
// Generic response cache
//
// Used by the drilldown and per-area requests, which are small, bounded, and
// requested repeatedly. The sweep uses the versioned store above instead,
// because it needs independent chunks and a resumable manifest.
// ---------------------------------------------------------------------------

const RESPONSES = 'responses'
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface ResponseRecord<T> {
  url: string
  body: T
  fetchedAt: number
}

export async function readCache<T>(url: string): Promise<ResponseRecord<T> | null> {
  const rec = await store<ResponseRecord<T>>(RESPONSES, 'readonly', (s) => s.get(url))
  if (!rec || typeof rec.fetchedAt !== 'number') return null
  return rec
}

export function isFresh(rec: { fetchedAt: number }, ttlMs: number = DEFAULT_TTL_MS): boolean {
  return Date.now() - rec.fetchedAt < ttlMs
}

export async function writeCache<T>(url: string, body: T): Promise<void> {
  await store(RESPONSES, 'readwrite', (s) => s.put({ url, body, fetchedAt: Date.now() } as ResponseRecord<T>))
}

