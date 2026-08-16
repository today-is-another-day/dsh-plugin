import { describe, expect, it } from 'vitest'
import { formatBalance, formatTime, isDeepSeekModelName } from '../src/client/core.ts'

describe('formatBalance', () => {
  it('renders two decimals plus 元', () => {
    expect(formatBalance(70.79)).toBe('70.79元')
    expect(formatBalance('70.79')).toBe('70.79元')
  })

  it('renders integers with decimals', () => {
    expect(formatBalance(70)).toBe('70.00元')
  })

  it('renders zero', () => {
    expect(formatBalance(0)).toBe('0.00元')
  })

  it('passes through non-numeric values untouched', () => {
    expect(formatBalance('n/a')).toBe('n/a元')
  })
})

describe('isDeepSeekModelName', () => {
  it('matches DeepSeek-family display names case-insensitively', () => {
    expect(isDeepSeekModelName('DeepSeek-V4-Pro Max')).toBe(true)
    expect(isDeepSeekModelName('deepseek-chat')).toBe(true)
    expect(isDeepSeekModelName('DeepSeek Reasoner')).toBe(true)
  })

  it('rejects other vendors', () => {
    expect(isDeepSeekModelName('Claude Fable 5')).toBe(false)
    expect(isDeepSeekModelName('GPT-5.6 Luna')).toBe(false)
    expect(isDeepSeekModelName('')).toBe(false)
  })
})

describe('formatTime', () => {
  it('formats a timestamp as local date and time', () => {
    expect(formatTime(new Date(2026, 7, 15, 9, 5, 3).getTime())).toBe('2026/8/15 09:05:03')
  })

  it('renders a dash for invalid timestamps', () => {
    expect(formatTime(Number.NaN)).toBe('-')
  })
})
