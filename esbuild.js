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

// The extension runs in Node (host); vscode is provided at runtime.
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'out/extension.js',
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'silent',
  plugins: [watchLogPlugin],
};

// The query-console editor runs in the webview (browser); CodeMirror is bundled
// into a single self-contained asset so the webview needs no CDN (CSP-safe).
const webviewConfig = {
  entryPoints: ['src/webview/editor.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: 'media/editor.js',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'silent',
  plugins: [watchLogPlugin],
};

async function main() {
  const ext = await esbuild.context(extensionConfig);
  const web = await esbuild.context(webviewConfig);

  if (watch) {
    await Promise.all([ext.watch(), web.watch()]);
  } else {
    await Promise.all([ext.rebuild(), web.rebuild()]);
    await ext.dispose();
    await web.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
