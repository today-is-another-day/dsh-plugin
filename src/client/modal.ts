/**
 * Delete-confirmation modal: a plain fixed overlay appended to document.body
 * while `snapshot.confirmDeleteId` is set. Esc / backdrop click cancels;
 * the danger button drives controller.confirmDelete().
 */
import type { SidebarController } from "./controller.ts";
import { t } from "./locales.ts";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

export function mountConfirmModal(controller: SidebarController): () => void {
  let backdrop: HTMLElement | null = null;
  let lastSessionId: string | null = null;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && backdrop !== null) controller.cancelDelete();
  };
  document.addEventListener("keydown", onKeyDown);

  const close = () => {
    backdrop?.remove();
    backdrop = null;
    lastSessionId = null;
  };

  const render = () => {
    const snapshot = controller.getSnapshot();
    const sessionId = snapshot.confirmDeleteId;
    if (sessionId === null) {
      if (backdrop !== null) close();
      return;
    }
    const row = snapshot.rows.find((candidate) => candidate.sessionId === sessionId);
    const name = row?.title ?? sessionId;
    if (backdrop === null || lastSessionId !== sessionId) {
      close();
      lastSessionId = sessionId;
      backdrop = el("div", "arSec_modalBackdrop");
      backdrop.addEventListener("mousedown", (event) => {
        if (event.target === backdrop) controller.cancelDelete();
      });
      const modal = el("div", "arSec_modal");
      modal.setAttribute("role", "alertdialog");
      modal.setAttribute("aria-label", t("confirm.title"));

      const title = el("h2", "arSec_modalTitle");
      title.textContent = t("confirm.title");
      const message = el("p", "arSec_modalMessage");
      message.textContent = t("confirm.message", { name });
      const footer = el("footer", "arSec_modalFooter");
      const cancel = el("button", "arSec_modalButton");
      cancel.type = "button";
      cancel.dataset.kind = "cancel";
      cancel.textContent = t("confirm.cancel");
      cancel.addEventListener("click", () => controller.cancelDelete());
      const ok = el("button", "arSec_modalButton");
      ok.type = "button";
      ok.dataset.kind = "danger";
      ok.textContent = t("confirm.ok");
      ok.addEventListener("click", () => {
        void controller.confirmDelete();
      });
      footer.append(cancel, ok);
      modal.append(title, message, footer);
      backdrop.append(modal);
      document.body.append(backdrop);
      ok.focus();
    }
    // In-flight delete: disable the danger button.
    const ok = backdrop.querySelector<HTMLButtonElement>('[data-kind="danger"]');
    if (ok !== null) ok.disabled = snapshot.busy[sessionId] === "delete";
  };

  const unsubscribe = controller.subscribe(render);
  render();
  return () => {
    unsubscribe();
    document.removeEventListener("keydown", onKeyDown);
    close();
  };
}
