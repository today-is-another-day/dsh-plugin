/**
 * Badge mounting: injects the balance badge immediately left of the
 * composer model selector (the dsh-client-ui-model-selection trigger,
 * `button[aria-label^="Select model"]`) and keeps it there — the trigger is
 * React-managed, so the badge is plain DOM plus a MutationObserver self-heal
 * (the dsh-ssh / task-board pattern). The badge is visible only while the
 * trigger names a DeepSeek-family model, and polls the host route every 10s
 * while visible.
 */

import { BalanceApi } from './api.ts'
import { formatBalance, formatTime, isDeepSeekModelName, POLL_INTERVAL_MS } from './core.ts'
import type { BalanceError, BalanceSnapshot } from '../protocol.ts'

/** Stable data attribute identifying the injected badge. */
export const BADGE_SELECTOR = '[data-dsh-deepseek-balance]'

/**
 * Candidate anchors for the model selector trigger, tried in order. The
 * trigger carries stable aria semantics; the `triggerEffort`-span fallback
 * covers shells without the aria label. The first matching selector wins.
 */
const TRIGGER_SELECTORS: readonly string[] = [
  'button[aria-label^="Select model"]',
  'button:has(> span[class*="triggerEffort"])',
]

/**
 * Badge look: absolutely positioned, floating just left of the trigger's
 * wrapper (`_7KE1Ra_root`, position:relative) — out of the flex flow, so it
 * can never squeeze the model name into an ellipsis at any viewport width.
 */
const BADGE_STYLE =
  'position:absolute;right:calc(100% + 6px);top:50%;transform:translateY(-50%);' +
  'display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;' +
  'font-size:12px;line-height:20px;font-variant-numeric:tabular-nums;' +
  'border:1px solid rgba(128,128,128,.35);border-radius:10px;' +
  'background:rgba(128,128,128,.08);color:inherit;cursor:pointer;user-select:none;' +
  'white-space:nowrap;flex:0 0 auto;'

/** Error-state border/color. */
const ERROR_STYLE =
  'border-color:rgba(255,140,60,.8)!important;color:rgba(255,170,90,1)!important;'

/** Find the composer model selector trigger, or undefined while not mounted. */
function findTrigger(): HTMLElement | undefined {
  for (const selector of TRIGGER_SELECTORS) {
    const element = document.querySelector<HTMLElement>(selector)
    if (element !== null) return element
  }
  return undefined
}

/** Build the badge tooltip lines. */
function tooltip(snapshot: BalanceSnapshot | undefined, error: BalanceError | undefined): string {
  const lines: string[] = []
  if (error !== undefined) lines.push(`⚠ ${error.message}`)
  if (snapshot !== undefined) {
    lines.push(
      `余额：${snapshot.total} ${snapshot.currency}`,
      `充值：${snapshot.toppedUp} ${snapshot.currency}`,
      `赠送：${snapshot.granted} ${snapshot.currency}`,
      snapshot.isAvailable ? '' : '⚠ 余额存在，但 DeepSeek 标记为不可用于 API 调用',
      `更新时间：${formatTime(snapshot.updatedAt)}`,
    )
  } else if (error?.kind === 'missing_key') {
    lines.push('配置 DEEPSEEK_API_KEY 后自动恢复（DSH 与模型调用共用同一把 Key）。')
  }
  lines.push('点击立即刷新')
  return lines.filter(line => line !== '').join('\n')
}

/** Badge text for the current state. */
function badgeText(snapshot: BalanceSnapshot | undefined, error: BalanceError | undefined): string {
  if (snapshot !== undefined) return formatBalance(snapshot.total)
  if (error?.kind === 'missing_key') return '未配置Key'
  if (error !== undefined) return '查询失败'
  return '…'
}

/**
 * Mount the balance badge, waiting for the trigger to render and
 * self-healing on later React re-renders.
 * @param api - the balance API client the badge polls through.
 * @returns disposer removing the badge, observers, and timers.
 */
export function mountBalanceBadge(api: BalanceApi): () => void {
  const badge = document.createElement('span')
  badge.dataset.dshDeepseekBalance = ''
  badge.setAttribute('aria-hidden', 'true')
  badge.style.cssText = BADGE_STYLE
  badge.textContent = '…'

  let snapshot: BalanceSnapshot | undefined
  let lastError: BalanceError | undefined
  let inFlight = false
  let visible = false
  let timer: number | undefined

  const applyState = (): void => {
    badge.textContent = badgeText(snapshot, lastError)
    badge.setAttribute('title', tooltip(snapshot, lastError))
    badge.style.cssText = BADGE_STYLE + (lastError !== undefined && snapshot === undefined ? ERROR_STYLE : '')
    if (snapshot !== undefined && lastError !== undefined) {
      badge.style.cssText = BADGE_STYLE + 'border-color:rgba(255,140,60,.6);'
    }
  }

  const refresh = async (force: boolean): Promise<void> => {
    if (inFlight) return
    inFlight = true
    const result = await api.balance(force)
    inFlight = false
    if (result.data !== undefined) {
      snapshot = result.data
      lastError = undefined
    } else if (result.error !== undefined) {
      lastError = result.error
    }
    applyState()
  }

  const ensureTimer = (): void => {
    if (timer !== undefined) return
    timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void refresh(false)
    }, POLL_INTERVAL_MS)
  }

  const clearTimer = (): void => {
    if (timer !== undefined) {
      window.clearInterval(timer)
      timer = undefined
    }
  }

  const show = (): void => {
    const becameVisible = !visible
    visible = true
    badge.style.display = ''
    ensureTimer()
    if (becameVisible) void refresh(false)
  }

  const hide = (): void => {
    if (!visible) {
      badge.style.display = 'none'
      return
    }
    visible = false
    badge.style.display = 'none'
    clearTimer()
  }

  /** Reconcile trigger presence, placement, and visibility. */
  const sync = (): void => {
    const trigger = findTrigger()
    const label = trigger === undefined ? '' : `${trigger.getAttribute('aria-label') ?? ''} ${trigger.textContent ?? ''}`
    if (trigger === undefined || !isDeepSeekModelName(label)) {
      hide()
      return
    }
    // Anchor to the trigger's wrapper (the ModelSelect root, normally
    // position:relative). The badge is absolutely positioned out of the flow,
    // so the model name always keeps its native width.
    const root = trigger.parentElement
    if (root === null) {
      hide()
      return
    }
    if (getComputedStyle(root).position === 'static') {
      root.style.position = 'relative'
    }
    if (badge.parentElement !== root) {
      root.insertBefore(badge, root.firstChild)
    }
    show()
  }

  badge.addEventListener('click', (event) => {
    event.stopPropagation()
    event.preventDefault()
    void refresh(true)
  })

  // Body-level watcher: catches trigger arrival, replacement, and
  // full-teardown re-renders. Debounced to a microtask so bursts of
  // mutations coalesce.
  let scheduled = false
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      sync()
    })
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'title'],
  })

  // Returning to a visible tab refreshes immediately.
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible' && visible) void refresh(false)
  }
  document.addEventListener('visibilitychange', onVisibility)

  sync()

  return () => {
    observer.disconnect()
    clearTimer()
    document.removeEventListener('visibilitychange', onVisibility)
    badge.remove()
  }
}
