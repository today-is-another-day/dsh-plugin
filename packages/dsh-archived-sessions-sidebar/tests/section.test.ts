// @vitest-environment jsdom
/**
 * Section/modal DOM tests (jsdom): structure, collapse toggling, row
 * rendering, busy application, and the delete-confirmation modal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarController, type ControllerDeps } from "../src/client/controller.ts";
import {
  buildSection,
  syncSection,
  syncNote,
  formatRelativeTime,
} from "../src/client/section.ts";
import { mountConfirmModal } from "../src/client/modal.ts";

function fakeController(overrides: Partial<ControllerDeps> = {}) {
  const deps: ControllerDeps = {
    workspaces: {
      list: {
        getSnapshot: () => ({ archivedSessionIds: ["s1", "s2"], items: [] }),
        subscribe: () => () => {},
      },
      refresh: vi.fn().mockResolvedValue(undefined),
    },
    sessions: {
      list: {
        getSnapshot: () => ({
          byId: {
            s1: { displayTitle: "会话一", updatedAt: 1000, running: false },
            s2: { displayTitle: "会话二", updatedAt: 2000, running: true },
          },
        }),
        subscribe: () => () => {},
      },
      open: vi.fn(),
    },
    api: {
      unarchive: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
    },
    storage: {
      get: () => null,
      set: () => {},
    },
    now: () => 5_000_000,
    ...overrides,
  };
  const controller = new SidebarController(deps);
  controller.start();
  return { controller, deps };
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.lang = "zh";
});

describe("buildSection / syncSection", () => {
  it("renders header, count, rows and applies collapse state", () => {
    const { controller } = fakeController();
    const parts = buildSection(controller);
    document.body.append(parts.root);
    syncSection(controller, parts, controller.getSnapshot(), 5_000_000);

    expect(parts.header.textContent).toContain("已归档会话");
    expect(parts.count.textContent).toBe("2");
    const rows = parts.list.querySelectorAll("[data-session-id]");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("会话一");
    expect(rows[1].querySelector(".arSec_runningDot")).not.toBeNull();

    controller.toggleArchived();
    syncSection(controller, parts, controller.getSnapshot(), 5_000_000);
    expect(parts.header.dataset.collapsed).toBe("true");
  });

  it("header click toggles the controller collapse flag", () => {
    const { controller } = fakeController();
    const parts = buildSection(controller);
    document.body.append(parts.root);
    parts.header.click();
    expect(controller.getSnapshot().archivedCollapsed).toBe(true);
    parts.header.click();
    expect(controller.getSnapshot().archivedCollapsed).toBe(false);
  });

  it("empty archive renders the placeholder", () => {
    const { controller } = fakeController({
      workspaces: {
        list: {
          getSnapshot: () => ({ archivedSessionIds: [], items: [] }),
          subscribe: () => () => {},
        },
        refresh: vi.fn(),
      },
    });
    const parts = buildSection(controller);
    document.body.append(parts.root);
    syncSection(controller, parts, controller.getSnapshot(), 5_000_000);
    expect(parts.list.textContent).toContain("暂无已归档会话");
  });

  it("renders workspace group headers above their rows", () => {
    const { controller } = fakeController({
      workspaces: {
        list: {
          getSnapshot: () => ({
            archivedSessionIds: ["s1", "s2"],
            items: [{ workspaceId: "w1", title: "工作区甲", sessionIds: ["s1"] }],
          }),
          subscribe: () => () => {},
        },
        refresh: vi.fn(),
      },
    });
    const parts = buildSection(controller);
    document.body.append(parts.root);
    syncSection(controller, parts, controller.getSnapshot(), 5_000_000);
    const groups = parts.list.querySelectorAll(".arSec_group");
    expect(groups.length).toBe(2);
    expect(
      (groups[0].querySelector(".arSec_groupLabel") as HTMLElement).textContent,
    ).toBe("工作区甲");
    expect((groups[0].querySelector(".arSec_groupCount") as HTMLElement).textContent).toBe("1");
    expect(
      (groups[0].querySelector("[data-session-id]") as HTMLElement).dataset.sessionId,
    ).toBe("s1");
    expect(
      (groups[1].querySelector(".arSec_groupLabel") as HTMLElement).textContent,
    ).toBe("未分组");
    expect(
      (groups[1].querySelector("[data-session-id]") as HTMLElement).dataset.sessionId,
    ).toBe("s2");
  });

  it("group header click collapses that group's rows and flips the chevron state", () => {
    const { controller } = fakeController({
      workspaces: {
        list: {
          getSnapshot: () => ({
            archivedSessionIds: ["s1", "s2"],
            items: [{ workspaceId: "w1", title: "工作区甲", sessionIds: ["s1"] }],
          }),
          subscribe: () => () => {},
        },
        refresh: vi.fn(),
      },
    });
    const parts = buildSection(controller);
    document.body.append(parts.root);
    syncSection(controller, parts, controller.getSnapshot(), 5_000_000);
    const group = parts.list.querySelector<HTMLElement>(".arSec_group")!;
    expect(group.hasAttribute("data-collapsed")).toBe(false);
    expect(
      group.querySelector<HTMLButtonElement>(".arSec_groupHeader")!.getAttribute("aria-expanded"),
    ).toBe("true");

    (group.querySelector(".arSec_groupHeader") as HTMLButtonElement).click();
    expect(controller.getSnapshot().collapsedGroups["w1"]).toBe(true);
    syncSection(controller, parts, controller.getSnapshot(), 5_000_000);
    expect(group.hasAttribute("data-collapsed")).toBe(true);
    expect(
      group.querySelector<HTMLButtonElement>(".arSec_groupHeader")!.getAttribute("aria-expanded"),
    ).toBe("false");

    (group.querySelector(".arSec_groupHeader") as HTMLButtonElement).click();
    syncSection(controller, parts, controller.getSnapshot(), 5_000_000);
    expect(group.hasAttribute("data-collapsed")).toBe(false);
  });

  it("row actions drive the controller (open / unarchive / delete request)", async () => {
    const { controller, deps } = fakeController();
    // Let the availability probe (unarchive("")) settle, then count cleanly.
    await vi.waitFor(() => expect(deps.api.unarchive).toHaveBeenCalledWith(""));
    (deps.api.unarchive as ReturnType<typeof vi.fn>).mockClear();
    const parts = buildSection(controller);
    document.body.append(parts.root);
    syncSection(controller, parts, controller.getSnapshot(), 5_000_000);

    const first = parts.list.querySelector<HTMLElement>("[data-session-id]")!;
    (first.querySelector(".arSec_rowMain") as HTMLButtonElement).click();
    expect(deps.api.unarchive).toHaveBeenCalledWith("s1");
    await vi.waitFor(() => expect(deps.sessions.open).toHaveBeenCalledWith("s1"));

    const unarchive = first.querySelector<HTMLButtonElement>('[data-action="unarchive"]')!;
    unarchive.click();
    await vi.waitFor(() => expect(deps.api.unarchive).toHaveBeenCalledTimes(2));

    const del = first.querySelector<HTMLButtonElement>('[data-action="delete"]')!;
    del.click();
    expect(controller.getSnapshot().confirmDeleteId).toBe("s1");

    // Running session's delete button is disabled.
    const second = parts.list.querySelectorAll<HTMLElement>("[data-session-id]")[1];
    expect(
      second.querySelector<HTMLButtonElement>('[data-action="delete"]')!.disabled,
    ).toBe(true);
  });

  it("syncNote shows and clears error / hint", () => {
    const { controller } = fakeController();
    const parts = buildSection(controller);
    document.body.append(parts.root);
    syncNote(parts, { ...controller.getSnapshot(), error: "出错了" }, true);
    expect(parts.root.textContent).toContain("出错了");
    syncNote(parts, { ...controller.getSnapshot(), error: null, hint: null }, true);
    expect(parts.root.querySelector(".arSec_note")).toBeNull();
    syncNote(parts, controller.getSnapshot(), false);
    expect(parts.root.textContent).toContain("当前部署不可用");
  });
});

describe("mountConfirmModal", () => {
  it("opens on requestDelete, closes on cancel and on success", async () => {
    const { controller } = fakeController();
    const dispose = mountConfirmModal(controller);

    controller.requestDelete("s1");
    expect(document.querySelector(".arSec_modalBackdrop")).not.toBeNull();
    expect(document.body.textContent).toContain("删除已归档会话");
    expect(document.body.textContent).toContain("会话一");

    controller.cancelDelete();
    expect(document.querySelector(".arSec_modalBackdrop")).toBeNull();

    controller.requestDelete("s1");
    const ok = document.querySelector<HTMLButtonElement>('[data-kind="danger"]')!;
    ok.click();
    await vi.waitFor(() => expect(document.querySelector(".arSec_modalBackdrop")).toBeNull());
    dispose();
  });

  it("esc closes the modal", () => {
    const { controller } = fakeController();
    const dispose = mountConfirmModal(controller);
    controller.requestDelete("s1");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".arSec_modalBackdrop")).toBeNull();
    dispose();
  });
});

describe("formatRelativeTime", () => {
  it("formats just-now / minutes / hours / days / older", () => {
    const now = 1_700_000_000_000;
    expect(formatRelativeTime(now - 30_000, now)).toBe("刚刚");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toContain("分钟");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toContain("小时");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toContain("天");
    expect(formatRelativeTime(now - 10 * 86_400_000, now)).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(formatRelativeTime(0, now)).toBe("");
  });
});
