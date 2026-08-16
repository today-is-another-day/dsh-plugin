import { defineConfig } from 'tsdown'

// Dual-face build: the host half (src/index.ts) and the browser half
// (src/client/index.ts) each bundle into one file under lib/. Types are
// emitted separately by `tsc -p tsconfig.build.json` (see package.json
// build script). Peer dependencies stay external — resolved by the dsh
// profile that loads this plugin.
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    outDir: 'lib',
    clean: false,
    target: 'es2022',
    platform: 'neutral',
  },
  {
    // DSH loads browser plugin files as classic scripts. The client module
    // loader therefore requires a registered CommonJS factory, rather than
    // a top-level ESM module.
    entry: { client: 'src/client/index.ts' },
    format: ['cjs'],
    dts: false,
    sourcemap: true,
    outDir: 'lib',
    clean: false,
    target: 'es2022',
    platform: 'browser',
    outExtensions: () => ({ js: '.js' }),
    banner:
      'window.__ModuleLoader__.load({\n'
      + '  id: "dsh-deepseek-balance",\n'
      + '  factory: (require) => {\n'
      + '    var module = { exports: {} };\n'
      + '    var exports = module.exports;\n',
    footer: '\n    return module.exports;\n  },\n});',
  },
])
