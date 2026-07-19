import fs from 'node:fs';
import path from 'node:path';

/**
 * Windows note:
 * `@openai/codex-sdk` spawns the bundled Codex CLI without `windowsHide`,
 * which causes a black console window to flash for each IM-triggered run.
 *
 * We patch the installed SDK after `npm install` so the bridge can keep using
 * the upstream package while avoiding the extra console window on Windows.
 *
 * Maintenance rule:
 * - Keep this patch conservative and source-shape-gated.
 * - When upgrading `@openai/codex-sdk`, verify the spawn block still matches.
 * - If upstream adds `windowsHide` natively, remove this script.
 */
const PATCH_MARKER = 'windowsHide: process.platform === "win32"';
const MIN_SUPPORTED_SDK_VERSION = [0, 110, 0];

function logSkip(message) {
  console.warn(`[postinstall] ${message}`);
}

function resolveSdkPaths() {
  const packageRoot = path.join(process.cwd(), 'node_modules', '@openai', 'codex-sdk');
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const entryPath = path.join(packageRoot, 'dist', 'index.js');
  if (!fs.existsSync(packageJsonPath) || !fs.existsSync(entryPath)) {
    return null;
  }
  return { packageJsonPath, entryPath };
}

function readSdkVersion(packageJsonPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function isSupportedSdkVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
  if (!match) return false;
  const current = match.slice(1).map(Number);
  for (let index = 0; index < MIN_SUPPORTED_SDK_VERSION.length; index += 1) {
    if (current[index] > MIN_SUPPORTED_SDK_VERSION[index]) return true;
    if (current[index] < MIN_SUPPORTED_SDK_VERSION[index]) return false;
  }
  return true;
}

function applyPatch(filePath) {
  const source = fs.readFileSync(filePath, 'utf-8');
  if (source.includes(PATCH_MARKER)) {
    console.log('[postinstall] codex-sdk windowsHide patch already applied');
    return false;
  }

  const patched = source.replace(
    /const child = spawn\(this\.executablePath, commandArgs, \{\s*env,\s*signal: args\.signal\s*\}\);/,
    `const child = spawn(this.executablePath, commandArgs, {
      env,
      windowsHide: process.platform === "win32",
      signal: args.signal
    });`,
  );

  if (patched === source) {
    throw new Error(`Unable to locate Codex SDK spawn block in ${filePath}`);
  }

  fs.writeFileSync(filePath, patched, 'utf-8');
  console.log(`[postinstall] patched codex-sdk windowsHide in ${path.relative(process.cwd(), filePath)}`);
  return true;
}

if (process.platform !== 'win32') {
  console.log('[postinstall] non-Windows platform detected, skipping codex-sdk windowsHide patch');
  process.exit(0);
}

const sdkPaths = resolveSdkPaths();
if (!sdkPaths) {
  console.log('[postinstall] @openai/codex-sdk not installed, skipping windowsHide patch');
  process.exit(0);
}

const sdkVersion = readSdkVersion(sdkPaths.packageJsonPath);
if (!sdkVersion) {
  logSkip('unable to read @openai/codex-sdk version, skipping windowsHide patch');
  process.exit(0);
}

if (!isSupportedSdkVersion(sdkVersion)) {
  logSkip(`unsupported @openai/codex-sdk version ${sdkVersion}; skipping windowsHide patch`);
  process.exit(0);
}

try {
  applyPatch(sdkPaths.entryPath);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logSkip(`failed to patch codex-sdk windowsHide (${message}); install will continue and the Windows console may still appear`);
  process.exit(0);
}
