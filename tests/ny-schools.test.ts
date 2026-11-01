import { describe, expect, it } from 'vitest'
import { isInNycCoverage } from '../src/core/plugins/ny-schools'

describe('NYC DOE source coverage', () => {
  it('includes representative points in the borough coverage area', () => {
    expect(isInNycCoverage(40.75, -73.98)).toBe(true) // Manhattan
    expect(isInNycCoverage(40.64, -73.78)).toBe(true) // Queens
    expect(isInNycCoverage(40.91, -73.83)).toBe(true) // Bronx
  })

  it('does not issue NYC dataset queries for distant New York or US areas', () => {
    expect(isInNycCoverage(42.65, -73.75)).toBe(false) // Albany
    expect(isInNycCoverage(41.88, -87.63)).toBe(false) // Chicago
  })
})
