// @vitest-environment jsdom
/**
 * Mount tests (jsdom): section placement below the workspace region, the
 * workspace collapse toggle wiring, and MutationObserver self-healing after
 * a simulated shell re-render wipes the injected nodes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarController, type ControllerDeps } from "../src/client/controller.ts";
import { mountSection } from "../src/client/mount.ts";

// Mirrors the real shell DOM: the column root wraps the shell in a
// `[data-slot]` layer, and the workspace browser sits inside another
// display:contents `[data-slot]` layer inside the region area.
const FIXTURE = `
<div data-pane="sidebar">
  <div data-slot="shell">
    <div class="x_logoRow"></div>
    <div class="x_regionArea">
      <div data-slot="browser" style="display:contents">
        <div class="y_root">
          <div class="y_sectionHeader"></div>
          <div class="y_listArea"></div>
        </div>
      </div>
    </div>
    <div class="x_footArea"></div>
  </div>
</div>`;

function fakeController() {
  const deps: ControllerDeps = {
    workspaces: {
      list: {
        getSnapshot: () => ({ archivedSessionIds: ["s1"], items: [] }),
        subscribe: () => () => {},
      },
      refresh: vi.fn().mockResolvedValue(undefined),
    },
    sessions: {
      list: {
        getSnapshot: () => ({
          byId: { s1: { displayTitle: "会话一", updatedAt: 1000 } },
        }),
        subscribe: () => () => {},
      },
      open: vi.fn(),
    },
    api: {
      unarchive: vi.fn().mockResolvedValue({ ok: true }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
    },
    storage: { get: () => null, set: () => {} },
    now: () => Date.now(),
  };
  const controller = new SidebarController(deps);
  controller.start();
  return controller;
}

beforeEach(() => {
  document.body.innerHTML = FIXTURE;
  document.documentElement.lang = "zh";
});

describe("mountSection", () => {
  it("places the section between the region area and the foot area", () => {
    const controller = fakeController();
    const { disposer } = mountSection(controller);
    const column = document.querySelector('[data-pane="sidebar"]')!;
    const section = column.querySelector("[data-dsh-archived-section]");
    expect(section).not.toBeNull();
    const region = column.querySelector('[class*="regionArea"]')!;
    const foot = column.querySelector('[class*="footArea"]')!;
    expect(section!.nextElementSibling).toBe(foot);
    expect(section!.previousElementSibling).toBe(region);
    disposer();
  });

  it("injects the workspace collapse toggle into the workspace section header", () => {
    const controller = fakeController();
    const { disposer } = mountSection(controller);
    const header = document.querySelector('[class*="sectionHeader"]')!;
    const toggle = header.querySelector("[data-dsh-ws-collapse]");
    expect(toggle).not.toBeNull();

    // The collapse attribute lands on BOTH the real browser root (the
    // section header's parent, not the display:contents slot wrapper) and
    // the region area (so the region actually shrinks).
    const browser = header.parentElement!;
    const region = document.querySelector('[class*="regionArea"]')!;
    expect(browser.hasAttribute("data-dsh-ws-collapsed")).toBe(false);
    expect(region.hasAttribute("data-dsh-ws-collapsed")).toBe(false);
    (toggle as HTMLButtonElement).click();
    expect(controller.getSnapshot().workspaceCollapsed).toBe(true);
    expect(browser.hasAttribute("data-dsh-ws-collapsed")).toBe(true);
    expect(region.hasAttribute("data-dsh-ws-collapsed")).toBe(true);
    (toggle as HTMLButtonElement).click();
    expect(browser.hasAttribute("data-dsh-ws-collapsed")).toBe(false);
    expect(region.hasAttribute("data-dsh-ws-collapsed")).toBe(false);
    disposer();
  });

  it("self-heals after a re-render wipes the injected nodes", async () => {
    const controller = fakeController();
    const { disposer } = mountSection(controller);
    const column = document.querySelector('[data-pane="sidebar"]')!;

    // Simulate a React re-render: rebuild the column subtree without our nodes.
    const region = document.querySelector('[class*="regionArea"]')!;
    region.innerHTML = '<div class="y_root"><div class="y_sectionHeader"></div><div class="y_listArea"></div></div>';
    document.querySelector("[data-dsh-archived-section]")?.remove();

    await vi.waitFor(() => {
      expect(column.querySelector("[data-dsh-archived-section]")).not.toBeNull();
      expect(column.querySelector("[data-dsh-ws-collapse]")).not.toBeNull();
    });
    disposer();
  });

  it("disposer removes all injected nodes", async () => {
    const controller = fakeController();
    const { disposer } = mountSection(controller);
    const section = document.querySelector("[data-dsh-archived-section]")!;
    disposer();
    await vi.waitFor(() => {
      expect(document.contains(section)).toBe(false);
      expect(document.querySelector("[data-dsh-ws-collapse]")).toBeNull();
      expect(document.querySelector(".arSec_modalBackdrop")).toBeNull();
    });
  });
});
