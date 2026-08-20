import { spawn as nodeSpawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  URO_DASHBOARD_MARKER,
  DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
} from './dashboard-config.js';
import { readEnv } from './env-compat.js';

const LOOP_CLI_PATH = fileURLToPath(new URL('../bin/loop.js', import.meta.url));
const DEFAULT_PROBE_TIMEOUT_MS = 200;
const DEFAULT_STARTUP_TIMEOUT_MS = 1500;
const DEFAULT_STARTUP_POLL_MS = 50;
const MAX_PROBE_BYTES = 128 * 1024;

function dashboardUrl(port) {
  return `http://${DASHBOARD_HOST}:${port}/`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probe one loopback port for the marker already present in the URO dashboard page.
 * The result is deliberately small so callers can replace this function in tests.
 */
export function probeDashboard(port, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let request;
    let response;
    let connected = false;
    let answered = false;
    let settled = false;
    let body = '';

    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { response?.destroy(); } catch { /* best-effort probe cleanup */ }
      try { request?.destroy(); } catch { /* best-effort probe cleanup */ }
      resolve({ status });
    };
    const timer = setTimeout(() => finish(connected || answered ? 'foreign' : 'vacant'), timeoutMs);

    try {
      request = httpGet({ host: DASHBOARD_HOST, port, path: '/' }, (incoming) => {
        response = incoming;
        answered = true;
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => {
          body += chunk;
          if (body.includes(URO_DASHBOARD_MARKER)) finish('uroboros');
          else if (body.length > MAX_PROBE_BYTES) finish('foreign');
        });
        incoming.on('end', () => finish(
          body.includes(URO_DASHBOARD_MARKER) ? 'uroboros' : 'foreign',
        ));
        incoming.on('error', () => finish('foreign'));
      });
      request.on('socket', (socket) => {
        if (!socket.connecting) connected = true;
        socket.once('connect', () => { connected = true; });
      });
      request.on('error', () => finish(connected ? 'foreign' : 'vacant'));
    } catch {
      finish('vacant');
    }
  });
}

async function chooseEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, DASHBOARD_HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error('could not allocate a dashboard port'));
        else resolve(port);
      });
    });
  });
}

function openBrowserDefault(url, { spawn = nodeSpawn, platform = process.platform } = {}) {
  const command = platform === 'win32'
    ? { bin: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
    : platform === 'darwin'
      ? { bin: 'open', args: [url] }
      : { bin: 'xdg-open', args: [url] };
  try {
    const child = spawn(command.bin, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once?.('error', () => {});
    child.unref?.();
  } catch {
    // Browser launch is optional and must never affect the run.
  }
}

function maybeOpen(url, options) {
  if (!options.open) return;
  try {
    const result = (options.openBrowser ?? openBrowserDefault)(url, {
      spawn: options.spawnBrowser ?? nodeSpawn,
      platform: options.platform ?? process.platform,
    });
    result?.catch?.(() => {});
  } catch {
    // Browser launch is optional and must never affect the run.
  }
}

/**
 * Ensure a scratch-root dashboard is live. Every failure is converted into a plain
 * unavailable result; this function never exits the process or decides a run outcome.
 */
export async function launchDashboard(scratchRoot, options = {}) {
  const env = options.env ?? process.env;
  if (options.disabled === true || readEnv(env, 'NO_DASHBOARD') === '1') {
    return { status: 'disabled' };
  }

  let port = options.port ?? DEFAULT_DASHBOARD_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    return { status: 'unavailable', reason: `invalid dashboard port: ${port}` };
  }
  if (typeof scratchRoot !== 'string' || scratchRoot.length === 0) {
    return { status: 'unavailable', reason: 'dashboard scratch root is missing' };
  }

  try {
    if (port === 0) port = await (options.choosePort ?? chooseEphemeralPort)();
    const url = dashboardUrl(port);
    const probe = options.probe ?? probeDashboard;
    const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const initial = await probe(port, { timeoutMs: probeTimeoutMs });
    if (initial?.status === 'uroboros') {
      maybeOpen(url, options);
      return { status: 'reused', url };
    }
    if (initial?.status === 'foreign') {
      return {
        status: 'unavailable',
        reason: `port ${port} is occupied by something other than a CCC dashboard`,
      };
    }

    const spawn = options.spawn ?? nodeSpawn;
    let spawnError = null;
    let childExit = null;
    let child;
    try {
      child = spawn(options.execPath ?? process.execPath, [
        options.cliPath ?? LOOP_CLI_PATH,
        'dashboard',
        '--scratch-root', scratchRoot,
        '--port', String(port),
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once?.('error', (error) => { spawnError = error; });
      child.once?.('exit', (code, signal) => { childExit = { code, signal }; });
      child.unref?.();
    } catch (error) {
      return { status: 'unavailable', reason: `could not start dashboard: ${error.message}` };
    }
    if (!child) {
      return { status: 'unavailable', reason: 'could not start dashboard: no child process' };
    }

    const wait = options.wait ?? delay;
    const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const startupPollMs = options.startupPollMs ?? DEFAULT_STARTUP_POLL_MS;
    const deadline = Date.now() + Math.max(0, startupTimeoutMs);
    do {
      if (spawnError) {
        return { status: 'unavailable', reason: `could not start dashboard: ${spawnError.message}` };
      }
      if (childExit) {
        const detail = childExit.code === null ? `signal ${childExit.signal}` : `code ${childExit.code}`;
        return { status: 'unavailable', reason: `dashboard process exited with ${detail}` };
      }
      const remaining = Math.max(1, deadline - Date.now());
      const ready = await probe(port, { timeoutMs: Math.min(probeTimeoutMs, remaining) });
      if (ready?.status === 'uroboros') {
        maybeOpen(url, options);
        return { status: 'started', url };
      }
      if (ready?.status === 'foreign') {
        return {
          status: 'unavailable',
          reason: `port ${port} became occupied by something other than a CCC dashboard`,
        };
      }
      if (Date.now() >= deadline) break;
      await wait(Math.min(startupPollMs, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);

    if (spawnError) {
      return { status: 'unavailable', reason: `could not start dashboard: ${spawnError.message}` };
    }
    if (childExit) {
      const detail = childExit.code === null ? `signal ${childExit.signal}` : `code ${childExit.code}`;
      return { status: 'unavailable', reason: `dashboard process exited with ${detail}` };
    }
    return {
      status: 'unavailable',
      reason: `dashboard did not become available on port ${port} within ${startupTimeoutMs} ms`,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: `dashboard launcher failed: ${error?.message ?? String(error)}`,
    };
  }
}

function shellArg(value, platform) {
  const string = String(value);
  return platform === 'win32'
    ? `'${string.replaceAll("'", "''")}'`
    : `'${string.replaceAll("'", `'\"'\"'`)}'`;
}

export function dashboardManualCommand(scratchRoot, {
  port = DEFAULT_DASHBOARD_PORT,
  execPath = process.execPath,
  cliPath = LOOP_CLI_PATH,
  platform = process.platform,
} = {}) {
  return [execPath, cliPath, 'dashboard', '--scratch-root', scratchRoot, '--port', String(port)]
    .map((part) => shellArg(part, platform))
    .join(' ');
}

export function formatDashboardAnnouncement(result, scratchRoot, options = {}) {
  if (result.status === 'disabled') return '';
  if (result.status === 'started' || result.status === 'reused') {
    return [
      '=== CCC DASHBOARD ===',
      `Watch live: ${result.url}`,
      'Read-only view; it remains available after this run.',
      '=====================',
      '',
    ].join('\n');
  }
  const reason = result.reason ?? 'dashboard is unavailable';
  return [
    '=== CCC DASHBOARD UNAVAILABLE ===',
    `Reason: ${reason}`,
    `Start it manually: ${dashboardManualCommand(scratchRoot, options)}`,
    '=================================',
    '',
  ].join('\n');
}
