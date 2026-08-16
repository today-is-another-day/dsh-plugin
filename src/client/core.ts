/**
 * Framework-free client core: pure formatting / matching / state helpers,
 * unit-testable without a DOM.
 */

/** Format a balance value as the badge text, e.g. `70.79元`. */
export function formatBalance(total: string | number): string {
  const value = typeof total === 'number' ? total : Number.parseFloat(total)
  const text = Number.isFinite(value) ? value.toFixed(2) : String(total)
  return `${text}元`
}

/**
 * Whether a model-selector text refers to a DeepSeek-family model.
 * Matches display names like `DeepSeek-V4-Pro Max`; relay names for other
 * vendors (Claude / GPT) do not match.
 */
export function isDeepSeekModelName(text: string): boolean {
  return /deepseek/i.test(text)
}

/** Localized timestamp for tooltips, e.g. `2026/8/15 23:30:05`. */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '-'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** The polling interval (user requirement: refresh every 10s). */
export const POLL_INTERVAL_MS = 10_000
