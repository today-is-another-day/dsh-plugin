/**
 * Host API tests: route dispatch, loopback fence, unarchive via registry
 * primitives, and delete paths (409 / remove primitive / locate+rm fence).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApiHandler,
  unarchiveSession,
  deleteSession,
  purgeArchiveEntry,
  isTrustedApiRequest,
} from "../src/host/index.ts";

type Ctx = { get: (name: string) => unknown };

// -- fakes ----------------------------------------------------------------
class FakeRegistry {
  state: { archivedSessionIds: string[] } = { archivedSessionIds: ["s1", "s2"] };
  workspaceSessionIds: string[] = ["s1"];
  detach = vi.fn().mockImplementation(async (id: string) => {
    this.workspaceSessionIds = this.workspaceSessionIds.filter((s) => s !== id);
  });
  list() {
    return [
      {
        id: "w1",
        path: "/proj",
        sessionIds: [...this.workspaceSessionIds],
        detachSession: this.detach,
      },
    ];
  }
  requireState() {
    return this.state;
  }
  setState(next: { archivedSessionIds: string[] }) {
    this.state = next;
    return Promise.resolve();
  }
}

interface HeaderLike {
  id: string;
  createdAt?: number;
  cwd?: string;
}

class FakePersistence {
  headers: HeaderLike[] = [
    { id: "s1", createdAt: 1 },
    { id: "s2", createdAt: 2 },
  ];
  remove = vi.fn().mockResolvedValue(undefined);
  locatePath: string | undefined;
  async list() {
    return this.headers;
  }
  locate() {
    return this.locatePath === undefined ? undefined : { path: this.locatePath };
  }
}

class FakeSessions {
  flush = vi.fn().mockResolvedValue(undefined);
  get(id: string) {
    if (id === "s1" || id === "s2") return { header: { id } };
    return undefined;
  }
  list() {
    return [{ header: { id: "s1" } }, { header: { id: "s2" } }];
  }
}

function makeCtx(overrides: Record<string, unknown> = {}): {
  ctx: Ctx;
  registry: FakeRegistry;
  persistence: FakePersistence;
  sessions: FakeSessions;
} {
  const registry = new FakeRegistry();
  const persistence = new FakePersistence();
  const sessions = new FakeSessions();
  const agents = {
    get: (id: string) =>
      id === "running" ? { status: "running" } : id === "s1" || id === "s2" ? { status: "idle" } : undefined,
  };
  const services: Record<string, unknown> = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    sessions,
    agents,
    ...overrides,
  };
  const ctx: Ctx = { get: (name) => services[name] };
  return { ctx, registry, persistence, sessions };
}

// -- request/response doubles ----------------------------------------------
function makeReq(
  method: string,
  url: string,
  body?: string,
  headers: Record<string, string> = {},
) {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  let index = 0;
  const iterator = {
    next: async () =>
      index < chunks.length
        ? { value: chunks[index++], done: false }
        : { done: true },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return {
    method,
    url,
    headers: { host: "127.0.0.1:3080", ...headers },
    [Symbol.asyncIterator]: () => iterator,
  };
}

function makeRes() {
  const res = {
    status: 0,
    body: "",
    writeHead(status: number) {
      res.status = status;
    },
    end(body: string) {
      res.body = body;
    },
  };
  return res;
}

async function call(method: string, url: string, body?: string, headers?: Record<string, string>) {
  const { ctx } = makeCtx();
  const handler = createApiHandler(ctx as never);
  const res = makeRes();
  await handler(makeReq(method, url, body, headers) as never, res as never);
  return { status: res.status, payload: JSON.parse(res.body) as {
    ok?: boolean;
    value?: unknown;
    error?: { code: string; message: string };
  } };
}

let dshHome: string;
beforeEach(async () => {
  dshHome = await mkdtemp(join(tmpdir(), "dsh-archived-test-"));
  process.env.DSH_HOME = dshHome;
});
afterEach(async () => {
  delete process.env.DSH_HOME;
  await rm(dshHome, { recursive: true, force: true });
});

// -- tests -----------------------------------------------------------------
describe("loopback fence", () => {
  it("rejects non-loopback Host headers with 403", async () => {
    const { status, payload } = await call("POST", "/archived-sidebar/api/unarchive", "{}", {
      host: "192.168.1.20:3080",
    });
    expect(status).toBe(403);
    expect(payload.error?.code).toBe("forbidden");
  });

  it("rejects cross-site requests with 403", async () => {
    const { status } = await call("POST", "/archived-sidebar/api/unarchive", "{}", {
      "sec-fetch-site": "cross-site",
    });
    expect(status).toBe(403);
  });

  it("accepts a same-origin loopback request (empty body → 400)", async () => {
    const { status } = await call("POST", "/archived-sidebar/api/unarchive", undefined, {
      origin: "http://127.0.0.1:3080",
    });
    expect(status).toBe(400);
  });
});

describe("route dispatch", () => {
  it("rejects non-POST with 405", async () => {
    const { status } = await call("GET", "/archived-sidebar/api/unarchive");
    expect(status).toBe(405);
  });

  it("unknown methods are 404 (whitelist)", async () => {
    const { status } = await call("POST", "/archived-sidebar/api/archive", "{}");
    expect(status).toBe(404);
  });

  it("missing sessionId is 400", async () => {
    const { status } = await call("POST", "/archived-sidebar/api/unarchive", "{}");
    expect(status).toBe(400);
  });
});

describe("unarchive", () => {
  it("removes the id from the archive set through setState", async () => {
    const { ctx, registry } = makeCtx();
    await expect(unarchiveSession(ctx as never, "s1")).resolves.toEqual({
      sessionId: "s1",
      archived: false,
      known: true,
    });
    expect(registry.state.archivedSessionIds).toEqual(["s2"]);
  });

  it("clears ghost entries (record missing) instead of 404ing", async () => {
    const { ctx, registry } = makeCtx();
    // "nope" is still accounted by the workspace but its record is gone.
    registry.workspaceSessionIds = ["s1", "nope"];
    await expect(unarchiveSession(ctx as never, "nope")).resolves.toEqual({
      sessionId: "nope",
      archived: false,
      known: false,
    });
    // Stale accounting is also detached so the ghost cannot resurface in the
    // workspace list either.
    expect(registry.detach).toHaveBeenCalledWith("nope");
  });

  it("501s when the registry exposes no state primitives", async () => {
    const { ctx } = makeCtx({ workspaceRegistry: { list: () => [] } });
    await expect(unarchiveSession(ctx as never, "s1")).rejects.toMatchObject({
      status: 501,
      code: "unsupported",
    });
  });
});

describe("delete", () => {
  it("409s for a running session", async () => {
    const { ctx } = makeCtx({ agents: { get: () => ({ status: "running" }) } });
    await expect(deleteSession(ctx as never, "s1")).rejects.toMatchObject({
      status: 409,
      code: "session-busy",
    });
  });

  it("deletes idempotently for recordless (ghost) sessions: cleanup first", async () => {
    const { ctx, registry } = makeCtx();
    // "nope" is archived + accounted but has no record anywhere.
    registry.state.archivedSessionIds = ["nope", "s1", "s2"];
    registry.workspaceSessionIds = ["nope", "s1"];
    await expect(deleteSession(ctx as never, "nope")).resolves.toEqual({
      sessionId: "nope",
      deleted: true,
      recordRemoved: false,
      recordMissing: true,
      archiveEntryKept: false,
    });
    expect(registry.detach).toHaveBeenCalledWith("nope");
    expect(registry.state.archivedSessionIds).toEqual(["s1", "s2"]);
  });

  it("two-phase delete keeps the archive entry, purge then drops it", async () => {
    const { ctx, registry, persistence } = makeCtx();
    // Phase 1: record and accounting go, but the entry that hides the row from
    // the official workspace browser must survive — otherwise the row flashes
    // through the "ungrouped" bucket.
    await expect(deleteSession(ctx as never, "s1", true)).resolves.toMatchObject({
      sessionId: "s1",
      deleted: true,
      recordRemoved: true,
      archiveEntryKept: true,
    });
    expect(registry.detach).toHaveBeenCalledWith("s1");
    expect(persistence.remove).toHaveBeenCalledWith("s1");
    expect(registry.state.archivedSessionIds).toEqual(["s1", "s2"]);

    // Phase 2: the client has re-pulled its session baseline by now.
    await expect(purgeArchiveEntry(ctx as never, "s1")).resolves.toEqual({
      sessionId: "s1",
      purged: true,
    });
    expect(registry.state.archivedSessionIds).toEqual(["s2"]);
  });

  it("purge is idempotent for an id that is not archived", async () => {
    const { ctx, registry } = makeCtx();
    await expect(purgeArchiveEntry(ctx as never, "absent")).resolves.toEqual({
      sessionId: "absent",
      purged: true,
    });
    expect(registry.state.archivedSessionIds).toEqual(["s1", "s2"]);
  });

  it("detaches accounting, cleans the archive set, and removes the artifact", async () => {
    const { ctx, registry, persistence } = makeCtx();
    await expect(deleteSession(ctx as never, "s1")).resolves.toMatchObject({
      sessionId: "s1",
      deleted: true,
      recordRemoved: true,
      recordMissing: false,
    });
    expect(registry.detach).toHaveBeenCalledWith("s1");
    expect(registry.state.archivedSessionIds).toEqual(["s2"]);
    expect(persistence.remove).toHaveBeenCalledWith("s1");
  });

  it("falls back to locate+rm, fenced inside the sessions root", async () => {
    const sessionsRoot = join(dshHome, "sessions");
    const sessionDir = join(sessionsRoot, "--proj--", "s1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "log.jsonl"), "x");

    const { ctx, persistence } = makeCtx();
    persistence.remove = undefined as never;
    persistence.locatePath = join(sessionDir, "log.jsonl");
    await deleteSession(ctx as never, "s1");
    await expect(
      import("node:fs/promises").then((fs) => fs.stat(sessionDir)),
    ).rejects.toThrow();

    // Outside the sessions root → refused, nothing deleted.
    const outsideDir = join(tmpdir(), "dsh-outside");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "log.jsonl"), "x");
    persistence.locatePath = join(outsideDir, "log.jsonl");
    await expect(deleteSession(ctx as never, "s2")).rejects.toMatchObject({
      status: 403,
      code: "outside-sessions-root",
    });
  });
});

describe("isTrustedApiRequest", () => {
  it("accepts loopback hosts and rejects others", () => {
    const req = (headers: Record<string, string>) =>
      ({ headers } as unknown as Parameters<typeof isTrustedApiRequest>[0]);
    expect(isTrustedApiRequest(req({ host: "127.0.0.1:3080" }))).toBe(true);
    expect(isTrustedApiRequest(req({ host: "localhost:3080" }))).toBe(true);
    expect(isTrustedApiRequest(req({ host: "[::1]:3080" }))).toBe(true);
    expect(isTrustedApiRequest(req({ host: "127.0.0.2:3080" }))).toBe(true);
    expect(isTrustedApiRequest(req({ host: "10.0.0.1:3080" }))).toBe(false);
    expect(isTrustedApiRequest(req({}))).toBe(false);
    expect(
      isTrustedApiRequest(req({ host: "127.0.0.1:3080", "sec-fetch-site": "cross-site" })),
    ).toBe(false);
  });
});
