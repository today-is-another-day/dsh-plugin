/**
 * dsh-archived-sessions-sidebar — host half.
 *
 * Self-contained Archived Sessions sidebar manager. Exposes a fenced JSON API
 * under /archived-sidebar/api/* that the client sidebar section calls:
 *   unarchive { sessionId } → move the session back out of the registry-global
 *                             archive set (its workspace slot is retained, so
 *                             its original position is restored)
 *   delete    { sessionId } → permanently delete one session (workspace
 *                             accounting detached, archive-set entry removed,
 *                             persisted artifact deleted)
 *
 * Unarchive uses the same public registry primitives the official
 * archiveSession is built on (`requireState` + `setState`), so it works on a
 * stock Harness without any core patch. The read-modify-write runs inside the
 * plugin's serialized mutation queue so concurrent requests cannot lose
 * updates; any residual cross-queue race (official archiveSession queue vs
 * this queue) is healed by the client's list refresh.
 *
 * The API only trusts loopback requests (127.0.0.1 / localhost / ::1) plus
 * same-origin markers — on a LAN-hosted deployment every request is refused
 * with 403.
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "schemastery";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

const name = "dsh-archived-sessions-sidebar";

/**
 * agentLoop is an optional capability (missing → delete degrades to a 409 /
 * best-effort path), deliberately NOT in inject: cordis `inject` declares
 * required dependencies (a miss blocks plugin startup), while `ctx.get` is a
 * lenient read that suits this "use when present, degrade when absent" case.
 */
const inject = [
  "webServer",
  "workspaceRegistry",
  "sessionPersistence",
  "sessions",
  "agents",
  "systemPrompt",
];

/** Loader config: only the agent-facing announcement toggle. */
const Config = z.object({
  announceToAgent: z.boolean().default(true),
});

/** Model-facing announcement (registered as a systemPrompt section). */
const GUIDANCE =
  "本机已安装 dsh-archived-sessions-sidebar 插件（DSH Web GUI 的侧边栏「已归档会话」区域）：位于左侧边栏工作区下方，与工作区一样可折叠收起。能力：查看已归档会话（标题、相对时间）、打开（自动先取消归档）、取消归档（恢复到原工作区位置）、删除（永久移除记录，运行中会话拒绝）。数据源为 DSH 官方 workspace 归档集合与会话记录；宿主进程经 /archived-sidebar/api/* 回环路由提供取消归档与删除。用户提到「已归档会话 / 归档会话 / 取消归档 / 恢复会话」时即指本插件，请据此协作。";

// -- structural faces (kept local so the host bundle stays dependency-light) --
type SessionHeaderLike = {
  readonly id: string;
  readonly createdAt?: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly origin?: string;
};
type SessionLike = { header: SessionHeaderLike };
type HttpRequest = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator]?: () => AsyncIterableIterator<Buffer>;
};
type HttpResponse = {
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};
type RegistryLike = {
  list: () => Array<{
    id?: string;
    path?: string;
    sessionIds?: string[];
    detachSession?: (id: string) => Promise<void> | void;
  }>;
  requireState: () => { archivedSessionIds: string[] };
  setState: (state: unknown) => Promise<void> | void;
  archiveSession?: (id: string) => Promise<void> | void;
};
type PersistenceLike = {
  list?: () => Promise<SessionHeaderLike[]>;
  locate?: (meta: SessionHeaderLike) => { path: string } | undefined;
  remove?: (id: string) => Promise<void> | void;
};
type SessionsLike = {
  get?: (id: string) => SessionLike | undefined;
  list?: () => SessionLike[];
  flush?: (session: SessionLike) => Promise<void> | void;
};
type AgentsLike = {
  get?: (id: string) => { status?: string } | undefined;
};

// -- session storage fence -------------------------------------------------
/** The DSH home directory (matches the official `resolveDshHome` semantics). */
function dshHome() {
  const raw = process.env.DSH_HOME;
  const configured =
    raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined;
  let base = configured ?? join(homedir(), ".dsh");
  if (base === "~") base = homedir();
  else if (base.startsWith("~/") || base.startsWith("~\\"))
    base = join(homedir(), base.slice(2));
  else if (base.startsWith("~")) base = join(homedir(), base.slice(1));
  return resolve(base);
}
/** Session root directory (`{DSH_HOME}/sessions`). */
function sessionsRoot() {
  return join(dshHome(), "sessions");
}

/** Locate a session header by id (live sessions first, then persisted meta). */
async function findSessionMeta(
  ctx: Context,
  sessionId: string,
): Promise<SessionHeaderLike | undefined> {
  const live = (ctx.get("sessions") as SessionsLike | undefined)?.get?.(sessionId);
  if (live !== undefined) return live.header;
  const persistence = ctx.get("sessionPersistence") as PersistenceLike | undefined;
  if (persistence?.list !== undefined) {
    for (const meta of await persistence.list())
      if (meta.id === sessionId) return meta;
  }
  return undefined;
}

// -- browser-trust fence (loopback + same-origin markers) -------------------
function headerOf(headers: HttpRequest["headers"], name: string) {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}
function parseAuthority(authority: string) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}
function isLoopbackHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}
function isTrustedApiRequest(request: HttpRequest) {
  const host = headerOf(request.headers, "host");
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (headerOf(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = headerOf(request.headers, "origin");
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

// -- HTTP helpers -----------------------------------------------------------
/** Whitelist of archived API methods; anything else is a 404. */
const ARCHIVED_API_METHODS = new Set(["unarchive", "delete", "purge"]);
const MAX_JSON_BODY_BYTES = 1024 * 1024;

async function readJsonBody(req: HttpRequest): Promise<Record<string, unknown>> {
  const contentType = headerOf(req.headers, "content-type");
  if (
    contentType !== undefined &&
    !/^application\/json\b/i.test(contentType.trim())
  ) {
    const error = new Error("content-type must be application/json") as Error & {
      status: number;
      code: string;
    };
    error.status = 415;
    error.code = "unsupported-media-type";
    throw error;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = req[Symbol.asyncIterator]?.();
  if (iterator !== undefined) {
    for await (const chunk of iterator) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buffer.length;
      if (total > MAX_JSON_BODY_BYTES) {
        const error = new Error("request body too large") as Error & {
          status: number;
          code: string;
        };
        error.status = 413;
        error.code = "body-too-large";
        throw error;
      }
      chunks.push(buffer);
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const error = new Error("invalid JSON body") as Error & {
      status: number;
      code: string;
    };
    error.status = 400;
    error.code = "bad-json";
    throw error;
  }
}
function writeJson(res: HttpResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function writeOk(res: HttpResponse, value: unknown) {
  writeJson(res, 200, { ok: true, value });
}
function writeFail(
  res: HttpResponse,
  message: string,
  status = 500,
  code = "internal",
) {
  writeJson(res, status, { ok: false, error: { code, message } });
}

// -- registry mutation queue ------------------------------------------------
// workspaceRegistry's requireState+setState are read-modify-write primitives;
// the official core serializes its own mutations through an internal queue.
// The plugin's unarchive/fallback-delete run through this queue so concurrent
// archive/unarchive/delete requests cannot lose updates.
let mutationTail: Promise<void> = Promise.resolve();
function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(() => operation());
  mutationTail = result.then(
    () => {},
    () => {},
  );
  return result;
}

function httpError(
  message: string,
  status: number,
  code: string,
): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Unarchive one session back into the active list. Uses the same public
 * registry primitives the official archiveSession is built on, so it works on
 * a stock Harness without any core patch.
 *
 * A session whose record is already gone (a ghost entry) is NOT an error:
 * the archive entry and the stale workspace accounting are cleared so the row
 * cannot linger in either list — the user asked to restore something that no
 * longer exists, so the correct outcome is "removed from the archive view".
 */
async function unarchiveSession(ctx: Context, sessionId: string) {
  const registry = ctx.get("workspaceRegistry") as RegistryLike | undefined;
  if (
    registry === undefined ||
    typeof registry.requireState !== "function" ||
    typeof registry.setState !== "function"
  ) {
    throw httpError(
      "当前 Harness 版本不支持取消归档（缺少 workspaceRegistry 状态原语）",
      501,
      "unsupported",
    );
  }
  const meta = await findSessionMeta(ctx, sessionId);
  await enqueueMutation(async () => {
    const state = registry.requireState();
    if (!state.archivedSessionIds.includes(sessionId)) return;
    await registry.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter(
        (id) => id !== sessionId,
      ),
    });
  });
  if (meta === undefined) {
    // Ghost: also drop the stale accounting so it can't resurface as an
    // ungrouped workspace row either.
    await detachFromWorkspaces(ctx, sessionId);
    return { sessionId, archived: false, known: false };
  }
  return { sessionId, archived: false, known: true };
}

/** Best-effort teardown of a live-but-idle session before removal. */
async function teardownLiveSession(ctx: Context, sessionId: string) {
  const sessions = ctx.get("sessions") as SessionsLike | undefined;
  const session = sessions?.get?.(sessionId);
  if (session !== undefined && sessions?.flush !== undefined) {
    try {
      await sessions.flush(session);
    } catch {
      // flush failure is non-fatal: the artifact removal below wins
    }
  }
  const loop = ctx.get("agentLoop") as
    | { disposeAgent?: (id: string) => Promise<void> | void }
    | undefined;
  if (loop?.disposeAgent !== undefined) {
    try {
      await loop.disposeAgent(sessionId);
    } catch {
      // dispose failure is non-fatal; continue with removal
    }
  }
}

/**
 * Detach the session from every workspace that accounts it (best-effort —
 * one workspace's detachSession failure must not block the operation).
 */
async function detachFromWorkspaces(ctx: Context, sessionId: string) {
  const registry = ctx.get("workspaceRegistry") as RegistryLike | undefined;
  for (const ws of registry?.list() ?? []) {
    if (!ws.sessionIds?.includes(sessionId)) continue;
    try {
      await ws.detachSession?.(sessionId);
    } catch (error) {
      console.error(
        `[dsh-archived-sessions-sidebar] detachSession failed for workspace "${
          ws.path ?? "?"
        }":`,
        error,
      );
    }
  }
}

/**
 * Remove the archive-set entry through the public registry primitives,
 * healing orphaned entries (ids whose records no longer exist) in the same
 * pass. Idempotent: an id absent from the set resolves without writing.
 */
async function removeFromArchiveSet(ctx: Context, sessionId: string) {
  const registry = ctx.get("workspaceRegistry") as RegistryLike | undefined;
  const persistence = ctx.get("sessionPersistence") as PersistenceLike | undefined;
  const sessions = ctx.get("sessions") as SessionsLike | undefined;
  if (
    registry === undefined ||
    typeof registry.requireState !== "function" ||
    typeof registry.setState !== "function"
  ) {
    return;
  }
  await enqueueMutation(async () => {
    const state = registry.requireState();
    if (!state.archivedSessionIds.includes(sessionId)) return;
    const existing = new Set<string>();
    for (const s of sessions?.list?.() ?? []) existing.add(s.header.id);
    if (persistence?.list !== undefined) {
      for (const h of await persistence.list()) existing.add(h.id);
    }
    const archivedSessionIds = state.archivedSessionIds.filter(
      (id) => id !== sessionId && existing.has(id),
    );
    await registry.setState({ ...state, archivedSessionIds });
  });
}

/**
 * Remove one session's persisted artifact (the backend's remove primitive
 * when present, otherwise locate + fenced rm). The resolved directory must
 * stay strictly INSIDE the sessions root — a third-party or damaged backend
 * could otherwise point the recursive rm at the whole session library (or
 * anything above it).
 * @returns whether the record directory was removed (false = not located).
 */
async function removeSessionArtifact(ctx: Context, sessionId: string, meta?: SessionHeaderLike) {
  const persistence = ctx.get("sessionPersistence") as PersistenceLike | undefined;
  // A missing record is already-deleted: never call the backend's remove for
  // a session it has no artifact for (some backends reject unknown ids).
  if (meta === undefined) return false;
  if (persistence?.remove !== undefined) {
    await persistence.remove(sessionId);
    return true;
  }
  const location = persistence?.locate?.(meta);
  if (location === undefined || typeof location.path !== "string") return false;
  const dir = dirname(location.path);
  const root = sessionsRoot();
  const rel = relative(root, dir);
  const insideRoot =
    dir !== "" &&
    rel !== "" &&
    rel !== "." &&
    !rel.startsWith("..") &&
    !isAbsolute(rel) &&
    dir !== dirname(dir);
  if (dir !== "" && insideRoot) {
    await rm(dir, { recursive: true, force: true });
    return true;
  }
  if (dir !== "" && !insideRoot) {
    throw httpError("拒绝删除：会话记录目录不在会话根目录内", 403, "outside-sessions-root");
  }
  return false;
}

/**
 * Delete ONE session only (no subagent cascade): detach workspace accounting,
 * drop the archive-set entry, and remove the persisted artifact. Subagent
 * children are intentionally LEFT ALONE — they surface as top-level rows
 * afterwards unless the user explicitly selects them.
 *
 * IDEMPOTENT: a session whose record is already gone (a ghost row left by an
 * earlier partial delete, or re-archived after removal) is NOT an error — the
 * accounting and archive-set cleanup still runs and the call reports success.
 * This is what lets the UI recover from the "找不到该会话的记录" loop: the
 * delete always reaches the registry cleanup first.
 */
async function deleteSessionSingle(
  ctx: Context,
  sessionId: string,
  keepArchiveEntry = false,
) {
  // Resolve the meta first for artifact removal, but a miss only means the
  // record is already gone — cleanup below still runs.
  const meta = await findSessionMeta(ctx, sessionId);

  await detachFromWorkspaces(ctx, sessionId);
  // Two-phase delete (keepArchiveEntry): the archive-set entry is what keeps
  // the official workspace browser from rendering the row (`sessionVisible`
  // hides every archived id). Dropping it here — while the client's session
  // list store still carries the row and its workspace accounting is already
  // detached — makes the row flash through the "ungrouped" bucket for exactly
  // one render. Callers that keep the entry re-pull their session baseline
  // first and then call `purge`, so the row leaves the store before it could
  // ever become visible.
  if (!keepArchiveEntry) await removeFromArchiveSet(ctx, sessionId);

  const recordRemoved = await removeSessionArtifact(ctx, sessionId, meta);
  return {
    sessionId,
    deleted: true,
    recordRemoved,
    recordMissing: meta === undefined,
    archiveEntryKept: keepArchiveEntry,
  };
}

/**
 * Phase two of the two-phase delete: drop the archive-set entry once the
 * caller's session baseline no longer carries the row. Idempotent and safe to
 * call for an id that was never archived (the underlying helper no-ops).
 */
async function purgeArchiveEntry(ctx: Context, sessionId: string) {
  await removeFromArchiveSet(ctx, sessionId);
  return { sessionId, purged: true };
}

/**
 * Permanently delete one session (running-agent guard + single-session
 * removal). Note: DSH exposes no public "current session" API on the host, so
 * the host cannot reject deleting the currently open session — the client
 * disables that row and the running-session 409 guard still applies.
 */
async function deleteSession(
  ctx: Context,
  sessionId: string,
  keepArchiveEntry = false,
) {
  const agent = (ctx.get("agents") as AgentsLike | undefined)?.get?.(sessionId);
  if (agent !== undefined && agent.status === "running") {
    throw httpError("会话正在运行，无法删除；请先停止该会话", 409, "session-busy");
  }
  if (agent !== undefined) await teardownLiveSession(ctx, sessionId);
  return deleteSessionSingle(ctx, sessionId, keepArchiveEntry);
}

/** Build the fenced /archived-sidebar/api route handler (exported for tests). */
function createApiHandler(ctx: Context) {
  return async (req: HttpRequest, res: HttpResponse) => {
    if (!isTrustedApiRequest(req)) {
      writeJson(res, 403, {
        ok: false,
        error: { code: "forbidden", message: "forbidden" },
      });
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, {
        ok: false,
        error: { code: "method-error", message: "method not allowed" },
      });
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
    const method = pathname.startsWith("/archived-sidebar/api/")
      ? pathname.slice("/archived-sidebar/api/".length)
      : undefined;
    if (method === undefined || method.includes("/") || method === "") {
      writeJson(res, 404, {
        ok: false,
        error: { code: "not-found", message: "unknown archived API method" },
      });
      return;
    }
    if (!ARCHIVED_API_METHODS.has(method)) {
      writeJson(res, 404, {
        ok: false,
        error: {
          code: "not-found",
          message: `unknown archived API method "${method}"`,
        },
      });
      return;
    }
    try {
      const payload = await readJsonBody(req);
      const sessionId =
        typeof payload.sessionId === "string" ? payload.sessionId : "";
      if (sessionId === "" || sessionId.length > 200) {
        writeJson(res, 400, {
          ok: false,
          error: {
            code: "bad-request",
            message:
              sessionId === ""
                ? "sessionId is required"
                : "sessionId is too long",
          },
        });
        return;
      }
      if (method === "unarchive") {
        writeOk(res, await unarchiveSession(ctx, sessionId));
      } else if (method === "delete") {
        // Absent flag = legacy single-phase delete, so an older cached client
        // bundle keeps working exactly as before.
        writeOk(
          res,
          await deleteSession(ctx, sessionId, payload.keepArchiveEntry === true),
        );
      } else if (method === "purge") {
        writeOk(res, await purgeArchiveEntry(ctx, sessionId));
      } else {
        writeJson(res, 404, {
          ok: false,
          error: {
            code: "not-found",
            message: `unknown archived API method "${method}"`,
          },
        });
      }
    } catch (error) {
      writeFail(
        res,
        error instanceof Error ? error.message : String(error),
        typeof (error as { status?: number })?.status === "number"
          ? (error as { status: number }).status
          : 500,
        typeof (error as { code?: string })?.code === "string"
          ? (error as { code: string }).code
          : "internal",
      );
    }
  };
}

function apply(ctx: Context, config?: { announceToAgent?: boolean }) {
  ctx.effect(
    () => {
      const webServer = ctx.get("webServer") as
        | { register: (route: unknown) => () => void }
        | undefined;
      if (webServer === undefined) return () => {};
      return webServer.register({
        kind: "prefix",
        path: "/archived-sidebar/api",
        handler: createApiHandler(ctx),
      });
    },
    "dsh-archived-sessions-sidebar: /archived-sidebar/api routes",
  );

  ctx.effect(
    () => {
      if (config?.announceToAgent === false) return () => {};
      const systemPrompt = ctx.get("systemPrompt") as
        | { section: (input: { name: string; order: number; text: string }) => () => void }
        | undefined;
      if (systemPrompt === undefined) return () => {};
      return systemPrompt.section({
        name: "plugin:dsh-archived-sessions-sidebar",
        order: 230,
        text: GUIDANCE,
      });
    },
    "dsh-archived-sessions-sidebar: announcement section",
  );
}

export { Config, GUIDANCE, apply, inject, name };
export {
  createApiHandler,
  isTrustedApiRequest,
  unarchiveSession,
  deleteSession,
  deleteSessionSingle,
  purgeArchiveEntry,
  enqueueMutation,
};
