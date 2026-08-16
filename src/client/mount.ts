/**
 * Sidebar mounting: injects the archived-sessions section below the
 * workspace browsing region (between the region area and the foot area) and
 * the workspace-region collapse chevron into the workspace section header.
 * Both are plain DOM children of React-owned surfaces, so a MutationObserver
 * self-heals re-insertion whenever a shell re-render wipes them (the same
 * proven pattern the task-board entry uses).
 */
import type { SidebarController } from "./controller.ts";
import { buildSection, syncNote, syncSection, ICONS } from "./section.ts";
import { mountConfirmModal } from "./modal.ts";
import { t } from "./locales.ts";

/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>(
    '[data-pane="sidebar"], [class*="sidebarCol"]',
  );
  if (column === null) return undefined;
  return (
    column.querySelector<HTMLElement>("[class*='logoRow']")?.parentElement ??
    (column.firstElementChild as HTMLElement | null) ??
    undefined
  );
}

/** The workspace browsing region (region area) and the foot area. */
function regionAndFoot(root: HTMLElement) {
  const region = root.querySelector<HTMLElement>("[class*='regionArea']");
  const foot = root.querySelector<HTMLElement>("[class*='footArea']");
  return { region, foot };
}

/**
 * The real workspace browser root inside the region area. The slot renderer
 * wraps the browser in a `display: contents` element, so the region's first
 * element child is NOT the browser — resolve it structurally through the
 * section header's parent instead.
 */
function browserRoot(root: HTMLElement) {
  return (
    regionAndFoot(root).region
      ?.querySelector<HTMLElement>("[class*='sectionHeader']")
      ?.parentElement ?? null
  );
}

/** The workspace section header row inside the browser root. */
function workspaceHeader(root: HTMLElement) {
  return browserRoot(root)?.querySelector<HTMLElement>("[class*='sectionHeader']") ?? null;
}

/** Build the workspace-region collapse chevron. */
function buildWorkspaceToggle(controller: SidebarController) {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.dataset.dshWsCollapse = "";
  toggle.title = t("ws.toggle");
  toggle.setAttribute("aria-label", t("ws.toggle"));
  toggle.innerHTML = ICONS.chevron;
  toggle.addEventListener("click", () => controller.toggleWorkspace());
  return toggle;
}

export interface MountedSection {
  disposer: () => void;
}

export function mountSection(controller: SidebarController): MountedSection {
  const parts = buildSection(controller);
  const workspaceToggle = buildWorkspaceToggle(controller);
  const disposeModal = mountConfirmModal(controller);

  let root: HTMLElement | undefined;
  let placed = false;
  let wsPlaced = false;

  const syncAll = () => {
    const snapshot = controller.getSnapshot();
    syncSection(controller, parts, snapshot, Date.now());
    syncNote(parts, snapshot, snapshot.available);
    if (snapshot.workspaceCollapsed) {
      workspaceToggle.dataset.collapsed = "true";
    } else {
      delete workspaceToggle.dataset.collapsed;
    }
    const browser = root !== undefined ? browserRoot(root) : null;
    const region = root !== undefined ? regionAndFoot(root).region : null;
    for (const target of [browser, region]) {
      if (target === null || target === undefined) continue;
      if (snapshot.workspaceCollapsed) target.dataset.dshWsCollapsed = "";
      else delete target.dataset.dshWsCollapsed;
    }
  };

  const tryPlace = () => {
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect();
      root = undefined;
      placed = false;
      wsPlaced = false;
    }
    if (placed && !document.body.contains(parts.root)) {
      rootObserver.disconnect();
      root = undefined;
      placed = false;
      wsPlaced = false;
    }
    root ??= sidebarRoot();
    if (root === undefined) return;
    const { foot } = regionAndFoot(root);
    if (!placed && foot !== undefined) {
      root.insertBefore(parts.root, foot);
      placed = true;
    }
    if (!wsPlaced) {
      const header = workspaceHeader(root);
      if (header !== null && !header.contains(workspaceToggle)) {
        header.append(workspaceToggle);
      }
      wsPlaced = header !== null;
    }
    if (placed) rootObserver.observe(root, { childList: true, subtree: true });
  };

  const waitObserver = new MutationObserver(() => {
    tryPlace();
  });
  waitObserver.observe(document.body, { childList: true, subtree: true });

  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false;
      wsPlaced = false;
      tryPlace();
      return;
    }
    // Re-insert anything a React re-render wiped. Do not unconditionally
    // sync here: this observer watches the complete sidebar subtree, and
    // syncSection() mutates our own DOM. An unconditional sync therefore
    // feeds the observer back into itself and starves the page's event loop.
    let repaired = false;
    const { foot } = regionAndFoot(root);
    if (!root.contains(parts.root)) {
      placed = false;
      if (foot !== undefined) {
        root.insertBefore(parts.root, foot);
        placed = true;
        repaired = true;
      }
    }
    const header = workspaceHeader(root);
    if (header !== null && !header.contains(workspaceToggle)) {
      header.append(workspaceToggle);
      repaired = true;
    }
    wsPlaced = header !== null;
    if (repaired) syncAll();
  });

  const unsubscribe = controller.subscribe(syncAll);
  tryPlace();
  syncAll();

  return {
    disposer: () => {
      waitObserver.disconnect();
      rootObserver.disconnect();
      unsubscribe();
      disposeModal();
      workspaceToggle.remove();
      parts.root.remove();
    },
  };
}
