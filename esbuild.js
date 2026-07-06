// Bundles src/extension.ts (+ its runtime deps like `pg`) into a single
// out/extension.js. We bundle because .vscodeignore keeps node_modules out of
// the .vsix, so anything we require at runtime has to be inlined here.
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Emits the begin/end markers our tasks.json background problem-matcher waits
// on, so F5 (preLaunchTask: watch) knows when a rebuild has settled.
const watchLogPlugin = {
  name: 'watch-log',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'out/extension.js',
    // vscode is provided by the host at runtime, never bundle it.
    external: ['vscode'],
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: 'silent',
    plugins: [watchLogPlugin],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
