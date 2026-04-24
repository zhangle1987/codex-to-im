import * as esbuild from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: [
    '@openai/codex-sdk',
    // Keep large IM SDKs external so global/local npm installs resolve them
    // from node_modules instead of inflating daemon.mjs.
    '@larksuiteoapi/node-sdk',
    // ws optional native deps
    'bufferutil', 'utf-8-validate',
    // Node.js built-ins
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
};

async function build(entryPoint, outfile) {
  await esbuild.build({
    ...common,
    entryPoints: [entryPoint],
    outfile,
  });
}

await build('src/main.ts', 'dist/daemon.mjs');
await build('src/ui-server.ts', 'dist/ui-server.mjs');
await build('src/cli.ts', 'dist/cli.mjs');

console.log('Built dist/daemon.mjs, dist/ui-server.mjs, dist/cli.mjs');
