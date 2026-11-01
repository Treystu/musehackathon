import type { AbsentReason, MetricUnit, MetricValue } from '../core/types'

const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const sweepNum = new Intl.NumberFormat('en-US')
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

/**
 * Names the cause instead of implying that an absent published figure is still
 * on its way. The audit of 33,791 areas found "not applicable" on medians where
 * a publisher had nothing to compute, while real zeroes remained valid counts.
 */
export function absenceLabel(reason: AbsentReason): string {
  switch (reason) {
    case 'not-applicable':
      return 'no valid data available here'
    case 'not-comparable':
      return 'not comparable'
    case 'missing':
      return 'not published'
    case 'too-few-households':
      return 'too few households to be reliable'
    case 'out-of-range':
      return 'outside the published range'
  }
}

export function isMetricDisplayable(value: number | null, unit: MetricValue['unit']): boolean {
  if (value === null || !Number.isFinite(value) || value < 0) return false
  if (unit === 'percent' && value > 100) return false
  return true
}

/** A headcount must not acquire a currency symbol; only monetary units get one. */
export function formatMetricMargin(moe: number, unit: MetricValue['unit']): string {
  if (unit === 'usd' || unit === 'usd_monthly') return usd.format(moe)
  return num.format(moe)
}

/** Formats a valid figure by unit; callers keep control of their absence wording. */
export function formatMetricNumber(
  value: number,
  unit: MetricUnit,
  options: { percentSuffix?: boolean; sweepPrecision?: boolean } = {},
): string {
  const number = options.sweepPrecision ? sweepNum : num

  switch (unit) {
    case 'usd':
      return usd.format(value)
    case 'usd_monthly':
      return `${usd.format(value)}/mo`
    case 'percent':
      return `${number.format(value)}${options.percentSuffix === false ? '' : '%'}`
    case 'ratio':
    case 'index':
      return String(value)
    case 'number':
      return number.format(value)
    case 'count':
    case 'institutions':
      return whole.format(value)
  }
}

/**
 * Renders a figure or a reason when it cannot be shown. The live ACS endpoint
 * for ZCTA 20771 returns -666666666 for medians and real zeroes for counts, so
 * an absence and a zero must remain distinct through formatting.
 */
export function formatMetricValue(m: MetricValue, reason?: AbsentReason): string {
  if (!isMetricDisplayable(m.value, m.unit)) {
    if (m.value !== null) return absenceLabel(reason ?? 'out-of-range')
    return absenceLabel(reason ?? 'missing')
  }

  const value = m.value as number
  if (m.displayPrecision !== undefined) {
    const fixed = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: m.displayPrecision,
      maximumFractionDigits: m.displayPrecision,
    })
    return fixed.format(value)
  }

  return formatMetricNumber(value, m.unit)
}
