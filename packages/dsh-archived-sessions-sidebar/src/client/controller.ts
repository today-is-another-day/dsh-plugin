/**
 * Sidebar section controller: pure client-side logic with every runtime face
 * injected behind small seams (stores / API / storage), so tests drive the
 * controller without a browser.
 *
 * Data flow:
 * - the archived set and its order come from `workspaces.list` (the
 *   `archivedSessionIds` array, updated by the host's changed frame on every
 *   archive/unarchive);
 * - titles/recency come from `sessions.list` (the store carries every
 *   session, archived ones included — only the workspace browser filters
 *   them out of grouping surfaces);
 * - mutations go through the plugin's loopback host API, followed by a
 *   `workspaces.refresh()` as belt-and-braces (the frame already delivers
 *   the change; the refresh heals any cross-queue race).
 */

import { t } from "./locales.ts";

export interface ArchivedRow {
  sessionId: string;
  /** Human label: durable title, or a session-id fallback. */
  title: string;
  /** Unix ms of the last activity; 0 when unknown. */
  updatedAt: number;
  running: boolean;
  /** False when the session list store has no row for this id. */
  known: boolean;
}

/** Stable key of the ungrouped bucket (groups are addressed by key). */
export const UNGROUPED_GROUP_KEY = "__ungrouped__";

/** One display bucket: a workspace's archived sessions, or the ungrouped tail. */
export interface ArchivedGroup {
  /** Stable addressing key: the workspace id, or {@link UNGROUPED_GROUP_KEY}. */
  key: string;
  /** Owning workspace id; undefined for the ungrouped bucket. */
  workspaceId?: string;
  /** Group header label (workspace title or the ungrouped fallback). */
  title: string;
  rows: ArchivedRow[];
}

export interface ControllerSnapshot {
  phase: "loading" | "ready";
  /** Flat row list (count, busy state, and modal lookups). */
  rows: ArchivedRow[];
  /** Workspace-grouped projection; empty while no workspaces exist (flat view). */
  groups: ArchivedGroup[];
  /** Per-group collapse flags keyed by {@link ArchivedGroup.key}. */
  collapsedGroups: Record<string, boolean>;
  archivedCollapsed: boolean;
  workspaceCollapsed: boolean;
  /** False when the loopback host API answered with a fence / non-JSON reply. */
  available: boolean;
  /** Per-session in-flight operation. */
  busy: Record<string, "unarchive" | "delete" | undefined>;
  /** Confirm dialog for a pending permanent delete. */
  confirmDeleteId: string | null;
  /** Latest inline error message (dismissed on the next action). */
  error: string | null;
  /** Latest non-error hint (e.g. after restoring an unknown session). */
  hint: string | null;
}

export type ApiFailure = { code: string; message: string };
/** Host operation value payload (delete/unarchive facts the UI copy needs). */
export interface ApiOkValue {
  /** False when the host found no record for the session (ghost entry). */
  known?: boolean;
  /** Whether the persisted record directory was actually removed. */
  recordRemoved?: boolean;
  /** True when the record was already gone before this delete. */
  recordMissing?: boolean;
}
export type ApiResult =
  | { ok: true; value?: ApiOkValue }
  | { ok: false; code: string; message: string };

/** Structural faces (the runtime satisfies them; tests inject fakes). */
export interface ObservableLike<T> {
  getSnapshot(): T;
  subscribe(fn: () => void): () => void;
}
/** Structural workspace view: id, display title, and the accounted sessions. */
export interface WorkspaceItemLike {
  workspaceId: string;
  title: string;
  sessionIds: string[];
}
export interface ControllerDeps {
  workspaces: {
    list: ObservableLike<{ archivedSessionIds: string[]; items: WorkspaceItemLike[] }>;
    refresh: () => Promise<void>;
  };
  sessions: {
    list: ObservableLike<{
      byId: Record<
        string,
        { displayTitle?: string; updatedAt?: number; running?: boolean }
      >;
    }>;
    open: (id: string) => void;
    /**
     * Re-pull the session baseline (core `session.list`). Optional so an older
     * runtime without the method still works — the row then heals on the next
     * reload instead of immediately.
     */
    refresh?: () => Promise<void>;
  };
  api: {
    unarchive: (id: string) => Promise<ApiResult>;
    /** Phase one: remove the record, keeping the archive-set entry. */
    delete: (id: string) => Promise<ApiResult>;
    /** Phase two: drop the archive-set entry. Optional for older hosts. */
    purge?: (id: string) => Promise<ApiResult>;
  };
  storage: {
    get: (key: string) => string | null;
    set: (key: string, value: string) => void;
  };
  now?: () => number;
}

/** Persistence key for the collapse state document. */
export const STORAGE_KEY = "dsh.archivedSidebar.v1";

interface PersistedState {
  archivedCollapsed: boolean;
  workspaceCollapsed: boolean;
  collapsedGroups: Record<string, boolean>;
}

function parsePersisted(raw: string | null): PersistedState {
  if (raw === null) {
    return { archivedCollapsed: false, workspaceCollapsed: false, collapsedGroups: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      archivedCollapsed: parsed.archivedCollapsed === true,
      workspaceCollapsed: parsed.workspaceCollapsed === true,
      collapsedGroups:
        parsed.collapsedGroups !== null &&
        typeof parsed.collapsedGroups === "object" &&
        !Array.isArray(parsed.collapsedGroups)
          ? (parsed.collapsedGroups as Record<string, boolean>)
          : {},
    };
  } catch {
    return { archivedCollapsed: false, workspaceCollapsed: false, collapsedGroups: {} };
  }
}

/** Title fallback for sessions the list store does not know. */
export function fallbackTitle(sessionId: string) {
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 10)}…`;
}

export class SidebarController {
  private readonly deps: ControllerDeps;
  private readonly listeners = new Set<() => void>();
  private disposers: Array<() => void> = [];
  /**
   * Ids inside an in-flight two-phase delete. Their archive-set entry is
   * deliberately still present (that entry is what hides the row from the
   * official workspace browser), so this set filters them out of OUR list to
   * keep the removal instantaneous for the user.
   */
  private readonly deleting = new Set<string>();
  private state: ControllerSnapshot = {
    phase: "loading",
    rows: [],
    groups: [],
    collapsedGroups: {},
    archivedCollapsed: false,
    workspaceCollapsed: false,
    available: true,
    busy: {},
    confirmDeleteId: null,
    error: null,
    hint: null,
  };

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    const persisted = parsePersisted(deps.storage.get(STORAGE_KEY));
    this.state.archivedCollapsed = persisted.archivedCollapsed;
    this.state.workspaceCollapsed = persisted.workspaceCollapsed;
    this.state.collapsedGroups = persisted.collapsedGroups;
  }

  start() {
    this.disposers.push(
      this.deps.workspaces.list.subscribe(() => this.derive()),
      this.deps.sessions.list.subscribe(() => this.derive()),
    );
    this.derive();
    void this.probeAvailability();
  }

  /**
   * Probe whether the loopback host API is reachable: a JSON-shaped reply
   * (any code except the loopback fence) means the route is live; a fence
   * 403, an SPA-fallback HTML body, or a transport error means unavailable.
   */
  private async probeAvailability() {
    try {
      const result = await this.deps.api.unarchive("");
      this.setAvailable(result.ok || result.code !== "forbidden");
    } catch {
      this.setAvailable(false);
    }
  }

  setAvailable(available: boolean) {
    if (this.state.available === available) return;
    this.state = { ...this.state, available };
    this.notify();
  }

  dispose() {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.listeners.clear();
  }

  getSnapshot(): ControllerSnapshot {
    return this.state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify() {
    for (const fn of [...this.listeners]) fn();
  }

  /** Project rows from the two stores (archived order × session rows). */
  private derive() {
    const workspaceList = this.deps.workspaces.list.getSnapshot();
    const archivedSessionIds = workspaceList.archivedSessionIds.filter(
      (sessionId) => !this.deleting.has(sessionId),
    );
    const byId = this.deps.sessions.list.getSnapshot().byId;
    const rows: ArchivedRow[] = archivedSessionIds.map((sessionId) => {
      const row = byId[sessionId];
      return {
        sessionId,
        title:
          row?.displayTitle !== undefined && row.displayTitle !== ""
            ? row.displayTitle
            : fallbackTitle(sessionId),
        updatedAt: row?.updatedAt ?? 0,
        running: row?.running === true,
        known: row !== undefined,
      };
    });

    // Workspace-grouped projection: each workspace's archived sessions in
    // registry order, then the ungrouped tail. Sessions keep their workspace
    // accounting slot while archived, so membership is derived from the
    // workspace views. With no workspaces at all the UI falls back to a flat
    // list (empty groups array).
    const groups: ArchivedGroup[] = [];
    const consumed = new Set<string>();
    for (const workspace of workspaceList.items ?? []) {
      const groupRows = rows.filter(
        (row) => workspace.sessionIds.includes(row.sessionId) && !consumed.has(row.sessionId),
      );
      for (const row of groupRows) consumed.add(row.sessionId);
      if (groupRows.length > 0) {
        groups.push({
          key: workspace.workspaceId,
          workspaceId: workspace.workspaceId,
          title: workspace.title,
          rows: groupRows,
        });
      }
    }
    const ungrouped = rows.filter((row) => !consumed.has(row.sessionId));
    if (ungrouped.length > 0 && (workspaceList.items ?? []).length > 0) {
      groups.push({ key: UNGROUPED_GROUP_KEY, title: t("group.ungrouped"), rows: ungrouped });
    }

    // Data is store-driven and failure-free; "loading" only covers the
    // pre-first-derive window so the UI can render a quiet placeholder.
    this.state = {
      ...this.state,
      rows,
      groups,
      phase: "ready",
    };
    this.notify();
  }

  private persistCollapse() {
    this.deps.storage.set(
      STORAGE_KEY,
      JSON.stringify({
        archivedCollapsed: this.state.archivedCollapsed,
        workspaceCollapsed: this.state.workspaceCollapsed,
        collapsedGroups: this.state.collapsedGroups,
      }),
    );
  }

  /** Toggle one group's collapse flag (persisted with the other flags). */
  toggleGroup(key: string) {
    this.state = {
      ...this.state,
      collapsedGroups: {
        ...this.state.collapsedGroups,
        [key]: !(this.state.collapsedGroups[key] === true),
      },
    };
    this.persistCollapse();
    this.notify();
  }

  toggleArchived() {
    this.state = {
      ...this.state,
      archivedCollapsed: !this.state.archivedCollapsed,
    };
    this.persistCollapse();
    this.notify();
  }

  toggleWorkspace() {
    this.state = {
      ...this.state,
      workspaceCollapsed: !this.state.workspaceCollapsed,
    };
    this.persistCollapse();
    this.notify();
  }

  private beginBusy(sessionId: string, op: "unarchive" | "delete") {
    this.state = { ...this.state, busy: { ...this.state.busy, [sessionId]: op } };
    this.notify();
  }

  private endBusy(sessionId: string) {
    const busy = { ...this.state.busy };
    delete busy[sessionId];
    this.state = { ...this.state, busy };
    this.notify();
  }

  /**
   * Re-pull BOTH baselines after a mutation.
   *
   * The workspace pull carries the archive set; the session pull is what
   * actually retires a deleted row. A delete performed through this plugin is
   * out-of-band for the core, which emits no session-removed frame — so the
   * client's session list keeps the row, and once the host has dropped its
   * archive-set entry and its workspace accounting, the official workspace
   * browser renders it as an UNGROUPED row. Re-pulling `session.list` drops
   * every row the host no longer lists (the baseline merge keeps only rows
   * present in the new response), which removes the ghost immediately instead
   * of asking the user to reload the page.
   */
  private async refreshAfterMutation(options?: { sessions?: boolean }) {
    const pulls: Array<Promise<void>> = [this.deps.workspaces.refresh()];
    const refreshSessions = this.deps.sessions.refresh;
    if (options?.sessions !== false && refreshSessions !== undefined) {
      pulls.push(refreshSessions.call(this.deps.sessions));
    }
    // Non-fatal per pull: the changed frame already updates the store in the
    // normal case; a failure leaves the next frame/baseline to heal it.
    await Promise.allSettled(pulls);
  }

  async unarchive(sessionId: string): Promise<boolean> {
    this.beginBusy(sessionId, "unarchive");
    try {
      const result = await this.deps.api.unarchive(sessionId);
      if (!result.ok) {
        this.state = { ...this.state, error: result.message, hint: null };
        this.notify();
        return false;
      }
      this.state = { ...this.state, error: null };
      await this.refreshAfterMutation();
      if (result.value?.known === false) {
        // Ghost entry: the record is gone; the host cleared the archive set
        // and the stale accounting. Explain instead of pretending it restored.
        this.state = { ...this.state, hint: t("unarchive.ghostHint") };
      }
      return true;
    } finally {
      this.endBusy(sessionId);
    }
  }

  /**
   * Open an archived session: restore it first (so it stays visible in the
   * workspace after the next reload), then navigate. For sessions the list
   * store does not know, navigation is skipped (open() requires a known row)
   * and a hint is shown instead.
   */
  async open(sessionId: string): Promise<boolean> {
    this.beginBusy(sessionId, "unarchive");
    try {
      const result = await this.deps.api.unarchive(sessionId);
      if (!result.ok) {
        this.state = { ...this.state, error: result.message, hint: null };
        this.notify();
        return false;
      }
      this.state = { ...this.state, error: null };
      await this.refreshAfterMutation();
      const row = this.deps.sessions.list.getSnapshot().byId[sessionId];
      if (row !== undefined) {
        this.deps.sessions.open(sessionId);
      } else {
        this.state = {
          ...this.state,
          hint: result.value?.known === false ? t("unarchive.ghostHint") : t("restored.hint"),
        };
      }
      return true;
    } finally {
      this.endBusy(sessionId);
    }
  }

  requestDelete(sessionId: string) {
    this.state = { ...this.state, confirmDeleteId: sessionId, error: null };
    this.notify();
  }

  cancelDelete() {
    this.state = { ...this.state, confirmDeleteId: null };
    this.notify();
  }

  /**
   * Two-phase delete, ordered so the row is never simultaneously (in the
   * session store) + (unaccounted by any workspace) + (absent from the archive
   * set) — the exact triple the official workspace browser renders as an
   * "ungrouped" row:
   *
   *   0. hide the row from THIS list right away (instant feedback);
   *   1. `delete` — record removed, workspace accounting detached, archive-set
   *      entry deliberately KEPT, so the workspace browser still filters it;
   *   2. re-pull `session.list` — the row leaves the core session store, after
   *      which no grouping surface can render it at all;
   *   3. `purge` — the now-unreferenced archive-set entry goes away;
   *   4. re-pull the workspace baseline.
   */
  async confirmDelete(): Promise<boolean> {
    const sessionId = this.state.confirmDeleteId;
    if (sessionId === null) return false;
    this.beginBusy(sessionId, "delete");
    this.deleting.add(sessionId);
    this.derive();
    try {
      const result = await this.deps.api.delete(sessionId);
      if (!result.ok) {
        // Nothing was removed: put the row back and report the failure.
        this.deleting.delete(sessionId);
        this.state = {
          ...this.state,
          error: result.message,
          confirmDeleteId: null,
          hint: null,
        };
        this.derive();
        return false;
      }
      this.state = { ...this.state, error: null, confirmDeleteId: null, hint: null };

      // Phase 2: retire the row from the core session store BEFORE the archive
      // entry disappears. Without this ordering the row flashes through the
      // ungrouped bucket for one render.
      const refreshSessions = this.deps.sessions.refresh;
      if (refreshSessions !== undefined) {
        try {
          await refreshSessions.call(this.deps.sessions);
        } catch {
          // Non-fatal: the purge below still runs; a stale row heals on reload.
        }
      }

      // Phase 3: drop the archive-set entry. A failure (or an older host
      // without the route) leaves an orphaned entry, which the host's own
      // orphan filter clears on the next mutation — so it is not surfaced.
      const purge = this.deps.api.purge;
      if (purge !== undefined) {
        try {
          await purge(sessionId);
        } catch {
          // swallowed on purpose (see above)
        }
      }

      // Phase 4: the session baseline was already re-pulled in phase 2.
      await this.refreshAfterMutation({ sessions: false });
      return true;
    } finally {
      this.deleting.delete(sessionId);
      this.endBusy(sessionId);
      this.derive();
    }
  }

  dismissError() {
    this.state = { ...this.state, error: null, hint: null };
    this.notify();
  }
}
