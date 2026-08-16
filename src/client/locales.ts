/**
 * Client copy: zh-first dictionaries with an English fallback, selected by
 * the document language. Kept dependency-free so the DOM-injected section
 * and the controller share one tiny lookup.
 */

/** zh dictionary (key-set source of truth). */
const zh = {
  "section.label": "已归档会话",
  "section.empty": "暂无已归档会话",
  "section.unavailable": "当前部署不可用（仅支持本机回环访问）",
  "section.loadError": "加载失败：{message}",
  "ws.toggle": "折叠/展开工作区",
  "group.ungrouped": "未分组",
  "group.toggle": "折叠/展开该分组",
  "action.open": "打开",
  "action.unarchive": "取消归档",
  "action.unarchiveTitle": "恢复到工作区",
  "action.delete": "删除",
  "action.deleteTitle": "永久删除该会话",
  "action.deleteDisabled": "会话正在运行，无法删除",
  "action.unknown": "会话记录不存在，仅可移除归档",
  "badge.running": "运行中",
  "confirm.title": "删除已归档会话",
  "confirm.message": "确定永久删除「{name}」吗？会话记录将被移除，此操作不可恢复。",
  "confirm.ok": "删除",
  "confirm.cancel": "取消",
  "error.unarchive": "取消归档失败：{message}",
  "error.delete": "删除失败：{message}",
  "error.open": "打开失败：{message}",
  "time.justNow": "刚刚",
  "time.minutesAgo": "{n} 分钟前",
  "time.hoursAgo": "{n} 小时前",
  "time.daysAgo": "{n} 天前",
  "time.older": "{date}",
  "unknown.title": "会话 {id}",
  "restored.hint": "已恢复归档，会话列表可能稍后刷新",
  "unarchive.ghostHint": "该会话记录已不存在，已从归档列表移除。",
} as const;

/** en dictionary, complete against the zh key set. */
const en: Record<keyof typeof zh, string> = {
  "section.label": "Archived Sessions",
  "section.empty": "No archived sessions",
  "section.unavailable": "Unavailable on this deployment (loopback-only API)",
  "section.loadError": "Load failed: {message}",
  "ws.toggle": "Collapse/expand the workspace region",
  "action.open": "Open",
  "action.unarchive": "Unarchive",
  "action.unarchiveTitle": "Restore to the workspace",
  "action.delete": "Delete",
  "action.deleteTitle": "Permanently delete this session",
  "action.deleteDisabled": "The session is running and cannot be deleted",
  "action.unknown": "Session record is gone; only un-archiving is possible",
  "badge.running": "running",
  "group.ungrouped": "Ungrouped",
  "group.toggle": "Collapse/expand this group",
  "confirm.title": "Delete Archived Session",
  "confirm.message": "Permanently delete \"{name}\"? The session record will be removed. This cannot be undone.",
  "confirm.ok": "Delete",
  "confirm.cancel": "Cancel",
  "error.unarchive": "Unarchive failed: {message}",
  "error.delete": "Delete failed: {message}",
  "error.open": "Open failed: {message}",
  "time.justNow": "just now",
  "time.minutesAgo": "{n} min ago",
  "time.hoursAgo": "{n} h ago",
  "time.daysAgo": "{n} d ago",
  "time.older": "{date}",
  "unknown.title": "Session {id}",
  "restored.hint": "Restored; the session list refreshes shortly",
  "unarchive.ghostHint": "This session's record no longer exists; it was removed from the archived list.",
};

/** Active dictionary, picked by the document language at call time. */
function dictionary() {
  return (
    typeof document !== "undefined" &&
    document.documentElement.lang.toLowerCase().startsWith("en")
  )
    ? en
    : zh;
}

/** Translate a key with optional {name} template params. */
export function t(
  key: keyof typeof zh,
  params?: Record<string, string | number>,
): string {
  let text: string = dictionary()[key];
  if (params !== undefined)
    for (const [name, value] of Object.entries(params))
      text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
