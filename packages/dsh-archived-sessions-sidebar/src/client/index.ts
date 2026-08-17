/**
 * dsh-archived-sessions-sidebar — client half.
 *
 * The browser entry: builds the loopback API client, wires the controller to
 * the runtime's `sessions` / `workspaces` services, and mounts the sidebar
 * section (plus the workspace-region collapse toggle) through plain DOM
 * injection with MutationObserver self-healing.
 */
import { SidebarController } from "./controller.ts";
import { mountSection } from "./mount.ts";
import type { ApiOkValue, ApiResult } from "./controller.ts";
import styles from "./styles.css";

/**
 * Required Cordis services. The package-level dsh.client.inject field brings
 * in the runtime module; this array must name the services it provides.
 */
const inject = ["sessions", "workspaces"];

const API_BASE = "/archived-sidebar/api";

/** Thin fetch client for the loopback host API. */
function hostApi(fetchImpl: typeof fetch) {
  const call = async (
    method: string,
    sessionId: string,
    extra?: Record<string, unknown>,
  ): Promise<ApiResult> => {
    let response: Response;
    try {
      response = await fetchImpl(`${API_BASE}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, ...extra }),
      });
    } catch (error) {
      return {
        ok: false,
        code: "transport",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    let payload: {
      ok?: boolean;
      value?: ApiOkValue;
      error?: { code?: string; message?: string };
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      return {
        ok: false,
        code: "not-json",
        message: `unexpected ${response.status} response`,
      };
    }
    if (payload.ok === true) return { ok: true, value: payload.value };
    return {
      ok: false,
      code: payload.error?.code ?? "unknown",
      message: payload.error?.message ?? `request failed (${response.status})`,
    };
  };
  return {
    unarchive: (id: string) => call("unarchive", id),
    // Phase one: keep the archive-set entry so the row stays hidden from the
    // official workspace browser until the session baseline has been re-pulled.
    delete: (id: string) => call("delete", id, { keepArchiveEntry: true }),
    // Phase two: drop the entry once the row has left the session store.
    purge: (id: string) => call("purge", id),
  };
}

/** Inject the section stylesheet once (guarded by a data attribute). */
function injectStyles() {
  const tagId = "dsh-archived-sessions-sidebar/styles.css";
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-archived-sessions-sidebar";
  tag.dataset.pluginCss = tagId;
  tag.textContent = styles;
  document.head.append(tag);
}

interface RuntimeCtx {
  workspaces: {
    list: {
      getSnapshot: () => {
        archivedSessionIds: string[];
        items: Array<{
          workspaceId: string;
          title: string;
          sessionIds: string[];
        }>;
      };
      subscribe: (fn: () => void) => () => void;
    };
    refresh: () => Promise<void>;
  };
  sessions: {
    list: {
      getSnapshot: () => {
        byId: Record<
          string,
          { displayTitle?: string; updatedAt?: number; running?: boolean }
        >;
      };
      subscribe: (fn: () => void) => () => void;
    };
    open: (id: string) => void;
    /** Core `SessionRuntime.refresh()` — re-pulls the `session.list` baseline. */
    refresh?: () => Promise<void>;
  };
  effect: (fn: () => (() => void) | void, label: string) => void;
}

function apply(ctx: RuntimeCtx) {
  injectStyles();
  ctx.effect(() => {
    const controller = new SidebarController({
      workspaces: ctx.workspaces,
      sessions: ctx.sessions,
      api: hostApi(window.fetch.bind(window)),
      storage: {
        get: (key) => window.localStorage?.getItem(key) ?? null,
        set: (key, value) => window.localStorage?.setItem(key, value),
      },
      now: () => Date.now(),
    });
    controller.start();
    const mounted = mountSection(controller);
    return () => {
      mounted.disposer();
      controller.dispose();
    };
  }, "dsh-archived-sessions-sidebar: sidebar section");
}

export { apply, inject };
