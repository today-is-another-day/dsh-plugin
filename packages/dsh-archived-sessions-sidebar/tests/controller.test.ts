/**
 * Controller tests: pure logic with fakes for stores / API / storage.
 */
import { describe, expect, it, vi } from "vitest";
import {
  SidebarController,
  fallbackTitle,
  STORAGE_KEY,
  type ControllerDeps,
  type ObservableLike,
} from "../src/client/controller.ts";

/** Minimal writable observable store (push-based like the real ones). */
class FakeStore<T> implements ObservableLike<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  getSnapshot() {
    return this.value;
  }
  set(next: T) {
    this.value = next;
    for (const fn of [...this.listeners]) fn();
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

class FakeStorage {
  map = new Map<string, string>();
  get(key: string) {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string) {
    this.map.set(key, value);
  }
}

function makeDeps(overrides: Partial<ControllerDeps> = {}) {
  const workspaceList = new FakeStore<{
    archivedSessionIds: string[];
    items: Array<{ workspaceId: string; title: string; sessionIds: string[] }>;
  }>({
    archivedSessionIds: ["s1", "s2"],
    items: [],
  });
  const sessionList = new FakeStore<{
    byId: Record<string, { displayTitle?: string; updatedAt?: number; running?: boolean }>;
  }>({
    byId: {
      s1: { displayTitle: "会话一", updatedAt: 1000, running: false },
      s2: { displayTitle: "会话二", updatedAt: 2000, running: true },
      s3: { displayTitle: "会话三", updatedAt: 3000, running: false },
      s4: { displayTitle: "会话四", updatedAt: 4000, running: false },
    },
  });
  const deps: ControllerDeps = {
    workspaces: {
      list: workspaceList,
      refresh: vi.fn().mockResolvedValue(undefined),
    },
    sessions: {
      list: sessionList,
      open: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
    },
    api: {
      unarchive: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
      purge: vi.fn().mockResolvedValue({ ok: true }),
    },
    storage: new FakeStorage(),
    now: () => 5000,
    ...overrides,
  };
  return { deps, workspaceList, sessionList };
}

describe("SidebarController", () => {
  it("projects rows from the archived set × session rows (fallback titles)", () => {
    const { deps, workspaceList } = makeDeps();
    workspaceList.set({ archivedSessionIds: ["s1", "missing"], items: [] });
    const controller = new SidebarController(deps);
    controller.start();
    const { rows } = controller.getSnapshot();
    expect(rows.map((row) => row.sessionId)).toEqual(["s1", "missing"]);
    expect(rows[0]).toMatchObject({ title: "会话一", known: true, running: false });
    expect(rows[1]).toMatchObject({ title: fallbackTitle("missing"), known: false });
    controller.dispose();
  });

  it("groups archived sessions by workspace, ungrouped tail last, archive order kept", () => {
    const { deps, workspaceList } = makeDeps();
    workspaceList.set({
      archivedSessionIds: ["s1", "s2", "s3", "s4", "missing"],
      items: [
        { workspaceId: "w1", title: "工作区一", sessionIds: ["s2", "s4"] },
        { workspaceId: "w2", title: "工作区二", sessionIds: ["s1", "s3"] },
      ],
    });
    const controller = new SidebarController(deps);
    controller.start();
    const { groups, rows } = controller.getSnapshot();
    expect(rows.length).toBe(5);
    expect(groups.map((group) => group.title)).toEqual(["工作区一", "工作区二", "未分组"]);
    expect(groups.map((group) => group.key)).toEqual(["w1", "w2", "__ungrouped__"]);
    expect(groups[0].rows.map((row) => row.sessionId)).toEqual(["s2", "s4"]);
    expect(groups[1].rows.map((row) => row.sessionId)).toEqual(["s1", "s3"]);
    expect(groups[2].rows.map((row) => row.sessionId)).toEqual(["missing"]);
    controller.dispose();
  });

  it("toggles and persists per-group collapse flags", () => {
    const { deps, workspaceList } = makeDeps();
    workspaceList.set({
      archivedSessionIds: ["s1", "s2", "s3"],
      items: [
        { workspaceId: "w1", title: "工作区一", sessionIds: ["s1", "s2"] },
        { workspaceId: "w2", title: "工作区二", sessionIds: ["s3"] },
      ],
    });
    const controller = new SidebarController(deps);
    controller.start();
    expect(controller.getSnapshot().collapsedGroups).toEqual({});
    controller.toggleGroup("w1");
    expect(controller.getSnapshot().collapsedGroups).toEqual({ w1: true });
    controller.toggleGroup("w1");
    expect(controller.getSnapshot().collapsedGroups).toEqual({ w1: false });

    // Persisted: a second controller on the same storage restores the flag.
    const raw = JSON.parse(deps.storage.get(STORAGE_KEY)!);
    expect(raw.collapsedGroups).toEqual({ w1: false });
    controller.toggleGroup("w2");
    const second = new SidebarController(deps);
    second.start();
    expect(second.getSnapshot().collapsedGroups).toEqual({ w1: false, w2: true });
    controller.dispose();
    second.dispose();
  });

  it("falls back to a flat list (empty groups) when no workspaces exist", () => {
    const { deps } = makeDeps();
    const controller = new SidebarController(deps);
    controller.start();
    expect(controller.getSnapshot().groups).toEqual([]);
    expect(controller.getSnapshot().rows.length).toBe(2);
    controller.dispose();
  });

  it("re-derives when either store changes", () => {
    const { deps, workspaceList } = makeDeps();
    const controller = new SidebarController(deps);
    controller.start();
    workspaceList.set({ archivedSessionIds: ["s2"], items: [] });
    expect(controller.getSnapshot().rows.map((row) => row.sessionId)).toEqual(["s2"]);
    controller.dispose();
  });

  it("persists both collapse flags under the versioned key", () => {
    const { deps } = makeDeps();
    const controller = new SidebarController(deps);
    controller.start();
    controller.toggleArchived();
    controller.toggleWorkspace();
    expect(JSON.parse(deps.storage.get(STORAGE_KEY)!)).toEqual({
      archivedCollapsed: true,
      workspaceCollapsed: true,
      collapsedGroups: {},
    });
    // A second controller on the same storage restores the flags.
    const second = new SidebarController(deps);
    second.start();
    expect(second.getSnapshot().archivedCollapsed).toBe(true);
    expect(second.getSnapshot().workspaceCollapsed).toBe(true);
    controller.dispose();
    second.dispose();
  });

  it("unarchive succeeds → refresh; failure → inline error", async () => {
    const { deps } = makeDeps();
    deps.api.unarchive = vi.fn().mockResolvedValue({ ok: true });
    const controller = new SidebarController(deps);
    controller.start();
    await expect(controller.unarchive("s1")).resolves.toBe(true);
    expect(deps.workspaces.refresh).toHaveBeenCalled();
    expect(controller.getSnapshot().error).toBeNull();

    deps.api.unarchive = vi.fn().mockResolvedValue({
      ok: false,
      code: "session-not-found",
      message: "找不到该会话",
    });
    await expect(controller.unarchive("s1")).resolves.toBe(false);
    expect(controller.getSnapshot().error).toBe("找不到该会话");
    controller.dispose();
  });

  it("open restores first, then navigates; unknown rows show a hint instead", async () => {
    const { deps } = makeDeps();
    const controller = new SidebarController(deps);
    controller.start();
    await controller.open("s1");
    expect(deps.api.unarchive).toHaveBeenCalledWith("s1");
    expect(deps.sessions.open).toHaveBeenCalledWith("s1");

    (deps.sessions.open as ReturnType<typeof vi.fn>).mockClear();
    await controller.open("missing");
    expect(deps.sessions.open).not.toHaveBeenCalled();
    expect(controller.getSnapshot().hint).not.toBeNull();
    controller.dispose();
  });

  it("delete flow: confirm modal state, then permanent delete + refresh", async () => {
    const { deps } = makeDeps();
    const controller = new SidebarController(deps);
    controller.start();
    controller.requestDelete("s1");
    expect(controller.getSnapshot().confirmDeleteId).toBe("s1");
    await expect(controller.confirmDelete()).resolves.toBe(true);
    expect(deps.api.delete).toHaveBeenCalledWith("s1");
    expect(deps.workspaces.refresh).toHaveBeenCalled();
    expect(controller.getSnapshot().confirmDeleteId).toBeNull();

    controller.requestDelete("s1");
    controller.cancelDelete();
    expect(controller.getSnapshot().confirmDeleteId).toBeNull();
    controller.dispose();
  });

  it("delete failure closes the modal and surfaces the error", async () => {
    const { deps } = makeDeps();
    deps.api.delete = vi.fn().mockResolvedValue({
      ok: false,
      code: "session-busy",
      message: "会话正在运行，无法删除",
    });
    const controller = new SidebarController(deps);
    controller.start();
    controller.requestDelete("s2");
    await expect(controller.confirmDelete()).resolves.toBe(false);
    expect(controller.getSnapshot().confirmDeleteId).toBeNull();
    expect(controller.getSnapshot().error).toBe("会话正在运行，无法删除");
    controller.dispose();
  });

  it("successful delete re-pulls the session baseline and reports nothing", async () => {
    const { deps } = makeDeps();
    // The core emits no session-removed frame for this out-of-band delete, so
    // the row would linger in the client session list (and surface as an
    // UNGROUPED workspace row) without an explicit session.list re-pull.
    const controller = new SidebarController(deps);
    controller.start();
    controller.requestDelete("s1");
    await controller.confirmDelete();
    expect(deps.sessions.refresh).toHaveBeenCalled();
    expect(deps.workspaces.refresh).toHaveBeenCalled();
    expect(controller.getSnapshot().hint).toBeNull();
    expect(controller.getSnapshot().error).toBeNull();
    controller.dispose();
  });

  it("delete orders the phases: delete → session re-pull → purge (no flash)", async () => {
    const { deps } = makeDeps();
    // The archive-set entry is what hides the row from the official workspace
    // browser, so it must outlive the session-store removal; purging it any
    // earlier is exactly what makes the row flash through "未分组".
    const calls: string[] = [];
    deps.api.delete = vi.fn().mockImplementation(async () => {
      calls.push("delete");
      return { ok: true };
    });
    deps.sessions.refresh = vi.fn().mockImplementation(async () => {
      calls.push("sessions.refresh");
    });
    deps.api.purge = vi.fn().mockImplementation(async () => {
      calls.push("purge");
      return { ok: true };
    });
    const controller = new SidebarController(deps);
    controller.start();
    controller.requestDelete("s1");
    await controller.confirmDelete();
    expect(calls).toEqual(["delete", "sessions.refresh", "purge"]);
    controller.dispose();
  });

  it("hides the row from this list the moment the delete starts", async () => {
    const { deps } = makeDeps();
    let hiddenDuringDelete: string[] | undefined;
    const controller = new SidebarController(deps);
    deps.api.delete = vi.fn().mockImplementation(async () => {
      // Mid-flight the archive-set entry still exists (by design), so only our
      // own filtering keeps the row from lingering in the sidebar.
      hiddenDuringDelete = controller.getSnapshot().rows.map((row) => row.sessionId);
      return { ok: true };
    });
    controller.start();
    controller.requestDelete("s1");
    await controller.confirmDelete();
    expect(hiddenDuringDelete).toEqual(["s2"]);
    controller.dispose();
  });

  it("restores the row when phase one fails", async () => {
    const { deps } = makeDeps();
    deps.api.delete = vi.fn().mockResolvedValue({
      ok: false,
      code: "session-busy",
      message: "会话正在运行，无法删除",
    });
    const controller = new SidebarController(deps);
    controller.start();
    controller.requestDelete("s1");
    await controller.confirmDelete();
    expect(controller.getSnapshot().rows.map((row) => row.sessionId)).toEqual(["s1", "s2"]);
    expect(deps.api.purge).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("tolerates a host without the purge route", async () => {
    const { deps } = makeDeps();
    delete deps.api.purge;
    const controller = new SidebarController(deps);
    controller.start();
    controller.requestDelete("s1");
    await expect(controller.confirmDelete()).resolves.toBe(true);
    expect(controller.getSnapshot().error).toBeNull();
    controller.dispose();
  });

  it("successful delete of a ghost (record already missing) still reports nothing", async () => {
    const { deps, sessionList } = makeDeps();
    deps.api.delete = vi.fn().mockResolvedValue({
      ok: true,
      value: { recordMissing: true, recordRemoved: false },
    });
    // Row disappears from the session list (record gone).
    sessionList.set({ byId: {} });
    const controller = new SidebarController(deps);
    controller.start();
    controller.requestDelete("s1");
    await controller.confirmDelete();
    expect(controller.getSnapshot().hint).toBeNull();
    controller.dispose();
  });

  it("delete still succeeds on a runtime without sessions.refresh", async () => {
    const { deps } = makeDeps();
    delete deps.sessions.refresh;
    const controller = new SidebarController(deps);
    controller.start();
    controller.requestDelete("s1");
    await expect(controller.confirmDelete()).resolves.toBe(true);
    expect(deps.workspaces.refresh).toHaveBeenCalled();
    controller.dispose();
  });

  it("unarchive of a ghost shows the ghost hint", async () => {
    const { deps } = makeDeps();
    deps.api.unarchive = vi.fn().mockResolvedValue({
      ok: true,
      value: { known: false },
    });
    const controller = new SidebarController(deps);
    controller.start();
    await controller.unarchive("s1");
    expect(controller.getSnapshot().hint).toContain("记录已不存在");
    controller.dispose();
  });

  it("availability probe: fence → unavailable, validation reply → available", async () => {
    const { deps } = makeDeps();
    deps.api.unarchive = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: "forbidden", message: "forbidden" });
    const controller = new SidebarController(deps);
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().available).toBe(false));

    deps.api.unarchive = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: "bad-request", message: "sessionId is required" });
    const second = new SidebarController(deps);
    second.start();
    await vi.waitFor(() => expect(second.getSnapshot().available).toBe(true));
    controller.dispose();
    second.dispose();
  });

  it("transport failure → unavailable", async () => {
    const { deps } = makeDeps();
    deps.api.unarchive = vi.fn().mockRejectedValue(new Error("network down"));
    const controller = new SidebarController(deps);
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().available).toBe(false));
    controller.dispose();
  });
});
