/**
 * Build script: bundles the dual-face plugin.
 *
 * - host half  (src/host/index.ts)  → lib/index.js   (ESM, externals kept)
 * - client half(src/client/index.ts) → lib/client.js  (CJS, wrapped in the
 *   browser module-loader handoff the core shell expects:
 *   window.__ModuleLoader__.load({ id, factory(require) }))
 *
 * The client source must keep dsh packages type-only (no runtime imports),
 * so the produced CJS body has no require() calls at all.
 */
import { build, context } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const NAME = "dsh-archived-sessions-sidebar";

/** Externalize every runtime dependency of the host half. */
const hostExternal = ["schemastery", "@deepseek-ai/*"];

/** Wrap a CJS bundle body into the shell's module-loader handoff. */
function wrapClient(body) {
  return (
    `window.__ModuleLoader__.load({\n` +
    `\tid: ${JSON.stringify(NAME)},\n` +
    `\tfactory: (require) => {\n` +
    `\t\tvar module = { exports: {} };\n` +
    `\t\tvar exports = module.exports;\n` +
    `\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n` +
    `\t\t${body.replaceAll("\n", "\n\t\t")}\n` +
    `\t\treturn module.exports;\n` +
    `\t}\n` +
    `});\n`
  );
}

/** Minimal hand-written type declarations for the published surfaces. */
function emitTypes() {
  mkdirSync(join(root, "lib/types"), { recursive: true });
  writeFileSync(
    join(root, "lib/types/index.d.ts"),
    `/**
 * dsh-archived-sessions-sidebar — host half.
 * Loopback-fenced JSON API under /archived-sidebar/api/* (unarchive, delete)
 * plus the agent system-prompt announcement section.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
export declare const name: string;
export declare const Config: z<{ announceToAgent?: boolean }>;
export declare const inject: string[];
export declare function apply(ctx: Context, config?: { announceToAgent?: boolean }): void;
/** Test surface: the fenced route handler factory. */
export declare function createApiHandler(ctx: Context): (req: unknown, res: unknown) => Promise<void>;
`,
  );
  writeFileSync(
    join(root, "lib/types/client.d.ts"),
    `/**
 * dsh-archived-sessions-sidebar — client half.
 * Mounts the collapsible "已归档会话" section below the sidebar workspace
 * region and the workspace-region collapse toggle; persistence via
 * localStorage key dsh.archivedSidebar.v1.
 */
export declare const inject: string[];
export declare function apply(ctx: unknown): void;
`,
  );
}

/** Client bundle task (write:false → wrapped handoff file). */
function clientBuildOptions() {
  return {
    entryPoints: [join(root, "src/client/index.ts")],
    write: false,
    outfile: join(root, "lib/client.js"),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2020",
    minify: false,
    logLevel: "info",
    loader: { ".css": "text" },
    plugins: [
      {
        name: "wrap-client-bundle",
        setup(buildCtx) {
          buildCtx.onEnd((result) => {
            const body = result.outputFiles?.find((file) => file.path.endsWith(".js"))?.text;
            if (body === undefined) return;
            mkdirSync(join(root, "lib"), { recursive: true });
            writeFileSync(join(root, "lib/client.js"), wrapClient(body));
            console.log("[build] client → lib/client.js");
          });
        },
      },
    ],
  };
}

async function buildOnce() {
  await build({
    entryPoints: [join(root, "src/host/index.ts")],
    outfile: join(root, "lib/index.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    external: hostExternal,
    sourcemap: true,
    logLevel: "info",
  });
  await build(clientBuildOptions());
  emitTypes();
  console.log("[build] done (host + client + types)");
}

if (watch) {
  const hostCtx = await context({
    entryPoints: [join(root, "src/host/index.ts")],
    outfile: join(root, "lib/index.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    external: hostExternal,
    sourcemap: true,
    logLevel: "info",
  });
  const clientCtx = await context(clientBuildOptions());
  await hostCtx.watch();
  await clientCtx.watch();
  console.log("[build:watch] watching src/host and src/client");
} else {
  buildOnce().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
