/**
 * DOM rendering for the sidebar section: header (label + count + collapse
 * chevron), the archived-session rows with hover actions, an inline
 * error/hint note, and the plain-overlay delete confirmation modal.
 *
 * Rendering is a full rebuild of the small list subtree whenever the row
 * array changes; busy/collapse/error state is applied in place so hover and
 * focus are not disturbed by unrelated controller notifications.
 */
import type {
  ArchivedGroup,
  ArchivedRow,
  ControllerSnapshot,
  SidebarController,
} from "./controller.ts";
import { t } from "./locales.ts";

/** Inline icons matching the shell's 16px look. */
export const ICONS = {
  archive: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5.5V13a1.5 1.5 0 0 0 1.5 1.5h8A1.5 1.5 0 0 0 13.5 13V5.5M2 5.5h12M9.5 8h-3M5 5.5V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2.5"/></svg>`,
  chevron: `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>`,
  restore: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9M2.5 8V4.5M2.5 8h3.5"/></svg>`,
  trash: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h11M6.5 2.5h3M4 4.5l.7 9a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-9M6.5 7v4M9.5 7v4"/></svg>`,
  open: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5H3.5v9h9V10M9.5 2.5h4v4M13 3 7.5 8.5"/></svg>`,
};

/** Compact relative time label. */
export function formatRelativeTime(ms: number, now: number): string {
  if (ms <= 0) return "";
  const minutes = Math.floor((now - ms) / 60000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("time.daysAgo", { n: days });
  const date = new Date(ms);
  return t("time.older", {
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

export interface SectionParts {
  root: HTMLElement;
  header: HTMLButtonElement;
  count: HTMLSpanElement;
  list: HTMLElement;
}

let lastGroups: ArchivedGroup[] | null = null;

/** Build the section root (header + list); listeners bind once. */
export function buildSection(controller: SidebarController): SectionParts {
  const root = el("div", "arSec_root");
  root.dataset.dshArchivedSection = "";

  const header = el("button", "arSec_header");
  header.type = "button";
  header.setAttribute("aria-expanded", "true");
  header.innerHTML = `<span class="arSec_icon">${ICONS.archive}</span><span class="arSec_label">${t("section.label")}</span><span class="arSec_count"></span><span class="arSec_chevron">${ICONS.chevron}</span>`;
  header.addEventListener("click", () => controller.toggleArchived());

  const list = el("div", "arSec_list");
  root.append(header, list);

  const count = header.querySelector(".arSec_count") as HTMLSpanElement;
  return { root, header, count, list };
}

function actionButton(action: string, icon: string, title: string, onClick: () => void, disabled = false) {
  const button = el("button", "arSec_action", icon);
  button.type = "button";
  button.dataset.action = action;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function buildRow(controller: SidebarController, row: ArchivedRow, now: number) {
  const item = el("div", "arSec_row");
  item.dataset.sessionId = row.sessionId;

  const main = el("button", "arSec_rowMain");
  main.type = "button";
  main.title = `${t("action.open")} — ${row.title}`;
  main.innerHTML = `<span class="arSec_rowTitle"></span><span class="arSec_rowMeta"></span>`;
  const title = main.querySelector(".arSec_rowTitle") as HTMLSpanElement;
  title.textContent = row.title;
  const meta = main.querySelector(".arSec_rowMeta") as HTMLSpanElement;
  const time = formatRelativeTime(row.updatedAt, now);
  meta.innerHTML = `${row.running ? `<span class="arSec_runningDot"></span>` : ""}<span>${time}</span>`;
  if (row.running) meta.setAttribute("title", t("badge.running"));
  main.addEventListener("click", () => {
    void controller.open(row.sessionId);
  });

  const actions = el("div", "arSec_actions");
  actions.append(
    actionButton("unarchive", ICONS.restore, t("action.unarchiveTitle"), () => {
      void controller.unarchive(row.sessionId);
    }),
    actionButton(
      "delete",
      ICONS.trash,
      row.running ? t("action.deleteDisabled") : t("action.deleteTitle"),
      () => {
        if (!row.running) controller.requestDelete(row.sessionId);
      },
      row.running,
    ),
  );

  item.append(main, actions);
  return item;
}

/** One group bucket: a clickable header row (label + count + chevron) plus its session rows. */
function buildGroup(controller: SidebarController, group: ArchivedGroup, now: number) {
  const bucket = el("div", "arSec_group");
  bucket.dataset.groupKey = group.key;

  const header = el("button", "arSec_groupHeader");
  header.type = "button";
  header.setAttribute("aria-expanded", "true");
  header.title = t("group.toggle");
  header.innerHTML = `<span class="arSec_groupLabel"></span><span class="arSec_groupCount"></span><span class="arSec_groupChevron">${ICONS.chevron}</span>`;
  const label = header.querySelector(".arSec_groupLabel") as HTMLSpanElement;
  label.textContent = group.title;
  const count = header.querySelector(".arSec_groupCount") as HTMLSpanElement;
  count.textContent = String(group.rows.length);
  header.addEventListener("click", () => controller.toggleGroup(group.key));

  bucket.append(header);
  for (const row of group.rows) bucket.append(buildRow(controller, row, now));
  return bucket;
}

/** Refresh the section from a controller snapshot (targeted updates). */
export function syncSection(
  controller: SidebarController,
  parts: SectionParts,
  snapshot: ControllerSnapshot,
  now: number,
) {
  if (snapshot.archivedCollapsed) {
    parts.header.dataset.collapsed = "true";
    parts.header.setAttribute("aria-expanded", "false");
  } else {
    delete parts.header.dataset.collapsed;
    parts.header.setAttribute("aria-expanded", "true");
  }
  parts.count.textContent = String(snapshot.rows.length);
  if (snapshot.rows.length > 0) {
    parts.header.dataset.hasCount = "";
  } else {
    delete parts.header.dataset.hasCount;
  }

  if (snapshot.groups !== lastGroups) {
    lastGroups = snapshot.groups;
    parts.list.textContent = "";
    if (snapshot.rows.length === 0) {
      const empty = el("div", "arSec_empty");
      empty.textContent = t("section.empty");
      parts.list.append(empty);
    } else if (snapshot.groups.length > 0) {
      for (const group of snapshot.groups) {
        parts.list.append(buildGroup(controller, group, now));
      }
    } else {
      // No workspaces: flat list without group headers.
      for (const row of snapshot.rows) {
        parts.list.append(buildRow(controller, row, now));
      }
    }
  }
  // Apply per-group collapse state in place (no rebuild → focus preserved).
  for (const group of parts.list.querySelectorAll<HTMLElement>(".arSec_group")) {
    const key = group.dataset.groupKey ?? "";
    const header = group.querySelector<HTMLButtonElement>(".arSec_groupHeader");
    if (snapshot.collapsedGroups[key] === true) {
      group.dataset.collapsed = "true";
      header?.setAttribute("aria-expanded", "false");
    } else {
      delete group.dataset.collapsed;
      header?.setAttribute("aria-expanded", "true");
    }
  }
  // Apply per-row busy state in place (no rebuild → hover/focus preserved).
  for (const item of parts.list.querySelectorAll<HTMLElement>("[data-session-id]")) {
    const id = item.dataset.sessionId ?? "";
    const busy = snapshot.busy[id];
    if (busy !== undefined) item.dataset.busy = busy;
    else delete item.dataset.busy;
  }
}

/** Render the inline note (error / hint / unavailable) above the list. */
export function syncNote(parts: SectionParts, snapshot: ControllerSnapshot, available: boolean) {
  let note = Array.from(parts.root.children).find((child) =>
    child.classList.contains("arSec_note"),
  ) as HTMLElement | undefined;
  const message = !available
    ? t("section.unavailable")
    : snapshot.error ?? snapshot.hint ?? null;
  if (message === null) {
    note?.remove();
    return;
  }
  if (note === undefined) {
    note = el("div", "arSec_note");
    parts.root.insertBefore(note, parts.list);
  }
  note.dataset.kind = !available || snapshot.error !== null ? "error" : "hint";
  note.textContent = message;
}
