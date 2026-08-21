/**
 * tsdown build for clickvibe:
 * - lib/index.js — the host-half plugin (ESM node),
 * - lib/client.js — the browser client bundle (CJS closure factory),
 *   registering with the package-name id `clickvibe` via
 *   window.__ModuleLoader__.load({ id, factory }).
 *
 * The client bundle replicates the official DSH client-bundle preset
 * (packages/client/tsdown.client.ts): externals resolve through the loader
 * module table at runtime (react, cordis, the dsh client packages); anything
 * else is inlined into the bundle.
 */
import type { UserConfig } from 'tsdown'

/** Module specifiers the web shell shares into the frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** The host-half build: plain ESM node module. */
const hostConfig: UserConfig = {
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  // clean stays off: the build script removes lib/ wholesale before tsc, so
  // a tsdown clean here would wipe the lib/types declarations tsc just emitted.
  clean: false,
  external: [/^@deepseek-ai\/.*/],
  noExternal: [],
}

/** The browser client bundle: CJS closure registered via the module loader. */
const clientConfig: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    'import.meta.resolve': 'undefined',
  },
  inputOptions: {
    resolve: {
      conditionNames: ['browser', 'import', 'require', 'default'],
    },
  },
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: "clickvibe", factory: (require) => {`,
    footer: `return module.exports; } });`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [hostConfig, clientConfig]
