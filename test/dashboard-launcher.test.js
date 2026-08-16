import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatDashboardAnnouncement,
  launchDashboard,
} from '../src/dashboard-launcher.js';
import { startDashboard } from '../src/dashboard.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

test('default launch starts a detached scratch-root dashboard and announces its URL', async () => {
  const probes = ['vacant', 'ccc'];
  const spawns = [];
  const child = new EventEmitter();
  let unrefCount = 0;
  child.unref = () => { unrefCount += 1; };

  const result = await launchDashboard('C:/scratch root', {
    env: {},
    port: 48123,
    probe: async () => ({ status: probes.shift() }),
    spawn: (...args) => { spawns.push(args); return child; },
    startupTimeoutMs: 50,
    wait: async () => {},
  });

  assert.deepEqual(result, { status: 'started', url: 'http://127.0.0.1:48123/' });
  assert.equal(spawns.length, 1, 'positive control: the default path must attempt a start');
  const [bin, args, options] = spawns[0];
  assert.equal(bin, process.execPath);
  assert.match(args[0], /bin[\\/]loop[.]js$/);
  assert.deepEqual(args.slice(1), [
    'dashboard', '--scratch-root', 'C:/scratch root', '--port', '48123',
  ]);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
  assert.equal(unrefCount, 1, 'the detached dashboard child must be unreferenced');

  const announcement = formatDashboardAnnouncement(result, 'C:/scratch root', { port: 48123 });
  assert.match(announcement, /^=== CCC DASHBOARD ===/);
  assert.match(announcement, /http:\/\/127[.]0[.]0[.]1:48123\//);
  assert.match(announcement, /read-only/i);
  assert.doesNotMatch(announcement, /^\[ccc\]/);
});

test('--no-dashboard and CCC_NO_DASHBOARD=1 perform no probe or spawn', async () => {
  let probes = 0;
  let spawns = 0;
  const dependencies = {
    probe: async () => { probes += 1; return { status: 'ccc' }; },
    spawn: () => { spawns += 1; throw new Error('must not spawn'); },
  };

  const flagResult = await launchDashboard('C:/scratch', {
    ...dependencies, env: {}, disabled: true,
  });
  const envResult = await launchDashboard('C:/scratch', {
    ...dependencies, env: { CCC_NO_DASHBOARD: '1' },
  });

  assert.deepEqual(flagResult, { status: 'disabled' });
  assert.deepEqual(envResult, { status: 'disabled' });
  assert.equal(probes, 0);
  assert.equal(spawns, 0);
  assert.equal(formatDashboardAnnouncement(flagResult, 'C:/scratch'), '');
});

test('an answering CCC dashboard is reused without spawning another process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-launcher-reuse-'));
  let dashboard;
  let spawnCount = 0;
  try {
    dashboard = await startDashboard({ scratchRoot: root, port: 0 });
    const result = await launchDashboard(root, {
      env: {},
      port: dashboard.port,
      spawn: () => { spawnCount += 1; throw new Error('must reuse'); },
    });
    assert.deepEqual(result, { status: 'reused', url: dashboard.url });
    assert.equal(spawnCount, 0, 'reuse must not create a second dashboard process');
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a foreign HTTP listener is not adopted and reports its occupied port', async () => {
  const foreign = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<h1>Definitely some other service</h1>');
  });
  const port = await listen(foreign);
  let spawnCount = 0;
  try {
    const result = await launchDashboard('C:/scratch', {
      env: {},
      port,
      spawn: () => { spawnCount += 1; throw new Error('must not spawn'); },
    });
    assert.equal(result.status, 'unavailable');
    assert.match(result.reason, new RegExp(`port ${port}.*other than a CCC dashboard`, 'i'));
    assert.equal(spawnCount, 0);
    assert.equal(Object.hasOwn(result, 'url'), false, 'a foreign service must not be claimed');
  } finally {
    await close(foreign);
  }
});

test('a wedged listener is bounded and treated as occupied', async () => {
  const wedged = createServer(() => {});
  const port = await listen(wedged);
  const startedAt = Date.now();
  try {
    const result = await launchDashboard('C:/scratch', {
      env: {}, port, probeTimeoutMs: 30,
      spawn: () => { throw new Error('must not spawn over a connected listener'); },
    });
    assert.equal(result.status, 'unavailable');
    assert.match(result.reason, new RegExp(`port ${port}.*other than`, 'i'));
    assert.ok(Date.now() - startedAt < 500, 'the HTTP probe must be tightly bounded');
  } finally {
    await close(wedged);
  }
});

test('spawn and browser failures are contained as plain launcher results', async () => {
  const failed = await launchDashboard('C:/scratch', {
    env: {},
    port: 48124,
    probe: async () => ({ status: 'vacant' }),
    spawn: () => { throw new Error('spawn denied'); },
  });
  assert.equal(failed.status, 'unavailable');
  assert.match(failed.reason, /spawn denied/);
  assert.match(
    formatDashboardAnnouncement(failed, 'C:/scratch', { port: 48124 }),
    /Start it manually: .*dashboard.*--scratch-root.*--port.*48124/i,
  );

  let browserCalls = 0;
  const reused = await launchDashboard('C:/scratch', {
    env: {},
    port: 48125,
    open: true,
    probe: async () => ({ status: 'ccc' }),
    openBrowser: () => { browserCalls += 1; throw new Error('headless'); },
  });
  assert.equal(reused.status, 'reused');
  assert.equal(browserCalls, 1);
});

test('--open uses the platform browser launcher without attaching it to the run', async () => {
  const cases = [
    ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler', 'http://127.0.0.1:48126/']],
    ['darwin', 'open', ['http://127.0.0.1:48126/']],
    ['linux', 'xdg-open', ['http://127.0.0.1:48126/']],
  ];
  for (const [platform, expectedBin, expectedArgs] of cases) {
    const calls = [];
    let unrefCount = 0;
    const child = new EventEmitter();
    child.unref = () => { unrefCount += 1; };
    const result = await launchDashboard('C:/scratch', {
      env: {}, port: 48126, open: true, platform,
      probe: async () => ({ status: 'ccc' }),
      spawnBrowser: (...args) => { calls.push(args); return child; },
    });
    assert.equal(result.status, 'reused');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], expectedBin);
    assert.deepEqual(calls[0][1], expectedArgs);
    assert.equal(calls[0][2].detached, true);
    assert.equal(calls[0][2].stdio, 'ignore');
    assert.equal(unrefCount, 1);
  }
});
