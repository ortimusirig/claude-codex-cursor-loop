import { createServer } from 'node:http';
import {
  DEFAULT_DASHBOARD_PORT,
  DASHBOARD_HOST,
} from './dashboard-config.js';
import {
  buildDashboardSnapshot,
  renderDashboardContent,
  renderDashboardPage,
  renderLogRows,
  renderCampaignGraph,
  renderRunDetail,
  snapshotForClient,
} from './dashboard-view.js';
import { LogRunNotFoundError, queryLogs } from './log-query.js';
import { buildCampaignGraph } from './campaign-graph.js';
import { readCampaignEventStream, readEventStream } from './event-stream.js';

export {
  buildDashboardSnapshot,
  renderDashboardContent,
  renderDashboardPage,
  renderCampaignGraph,
  renderLogRows,
  renderRunDetail,
} from './dashboard-view.js';

export { DEFAULT_DASHBOARD_PORT, DASHBOARD_HOST } from './dashboard-config.js';

function fingerprint(snapshot) {
  return JSON.stringify({
    mode: snapshot.mode,
    sourcePath: snapshot.sourcePath,
    message: snapshot.message,
    campaigns: snapshot.campaigns,
    runs: snapshot.runs,
    liveUnits: snapshot.liveUnits,
  });
}

export function createDashboardObserver(options, pollIntervalMs = 250) {
  const clients = new Set();
  let snapshot = buildDashboardSnapshot(options);
  let currentFingerprint = fingerprint(snapshot);
  let disposed = false;

  const send = (response) => {
    const payload = JSON.stringify({ snapshot: snapshotForClient(snapshot) });
    try {
      response.write(`event: snapshot\ndata: ${payload}\n\n`);
    } catch {
      clients.delete(response);
    }
  };
  const refresh = (broadcast = true) => {
    if (disposed) return snapshot;
    const next = buildDashboardSnapshot(options);
    const nextFingerprint = fingerprint(next);
    snapshot = next;
    if (nextFingerprint !== currentFingerprint) {
      currentFingerprint = nextFingerprint;
      if (broadcast) for (const client of clients) send(client);
    }
    return snapshot;
  };
  const poll = setInterval(refresh, pollIntervalMs);
  poll.unref();
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      try {
        client.write(': keepalive\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, 15000);
  heartbeat.unref();

  return {
    page() {
      return renderDashboardPage(refresh());
    },
    detail(runId) {
      const current = refresh();
      const run = current.runs.find((candidate) => candidate.runId === runId);
      return run ? renderRunDetail(run) : null;
    },
    logs(runId, problemsOnly = false) {
      try {
        return renderLogRows(queryLogs({ ...options, runId, problemsOnly }), { problemsOnly });
      } catch (error) {
        if (error instanceof LogRunNotFoundError) return null;
        throw error;
      }
    },
    graph(campaignId) {
      const current = refresh();
      if (current.mode === 'run') {
        return campaignId === null
          ? renderCampaignGraph({
              nodes: [], edges: [],
              message: 'A single-run dashboard has no campaign topology to display.',
            })
          : null;
      }
      if (current.campaigns.length === 0) {
        return campaignId === null
          ? renderCampaignGraph({
              nodes: [], edges: [],
              message: 'No campaigns are available in this scratch root yet.',
            })
          : null;
      }
      const selectedId = campaignId ?? (current.campaigns.length === 1
        ? current.campaigns[0].campaignId
        : null);
      if (selectedId === null) {
        return renderCampaignGraph({
          nodes: [], edges: [], message: 'Select a campaign to load its graph.',
        });
      }
      const campaign = current.campaigns.find((item) => item.campaignId === selectedId);
      if (!campaign) return null;
      const stream = readCampaignEventStream(campaign.directory);
      const declared = buildCampaignGraph(stream.events);
      const unitIds = new Set(declared.nodes.map((node) => node.unitId));
      const unitEvents = [];
      for (const run of current.runs) {
        if (!unitIds.has(run.runId)) continue;
        try {
          const runStream = readEventStream(run.directory, { allowMissing: true });
          unitEvents.push(...runStream.events.map((event) => ({
            ...event,
            unitId: typeof event.unitId === 'string' ? event.unitId : run.runId,
          })));
        } catch {
          // A unit stream can be between writes or independently unreadable. The declared
          // campaign graph remains authoritative and will be retried on the next request.
        }
      }
      return renderCampaignGraph(buildCampaignGraph(stream.events, { unitEvents }));
    },
    connect(request, response) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
      });
      response.flushHeaders?.();
      // Refresh before registering this response: existing clients receive a newly
      // discovered append, while this client receives exactly one initial snapshot.
      refresh();
      clients.add(response);
      send(response);
      request.once('close', () => clients.delete(response));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}

export async function startDashboard({
  runDirectory,
  scratchRoot,
  port = DEFAULT_DASHBOARD_PORT,
  pollIntervalMs = 250,
} = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('dashboard port must be an integer from 0 to 65535');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10) {
    throw new TypeError('dashboard poll interval must be an integer of at least 10 ms');
  }
  const options = { runDirectory, scratchRoot };
  // Validate source selection synchronously before occupying a port.
  buildDashboardSnapshot(options);
  const observer = createDashboardObserver(options, pollIntervalMs);
  const server = createServer((request, response) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Bad request\n');
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(observer.page());
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/events') {
      observer.connect(request, response);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/detail') {
      const runId = requestUrl.searchParams.get('runId');
      const html = runId === null ? null : observer.detail(runId);
      if (html === null) {
        response.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end('Pass not found\n');
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(html);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/logs') {
      const runId = requestUrl.searchParams.get('runId');
      const problemsOnly = requestUrl.searchParams.get('problemsOnly') === 'true';
      let html;
      try {
        html = observer.logs(runId, problemsOnly);
      } catch (error) {
        response.writeHead(500, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(`Cannot read logs: ${error.message}\n`);
        return;
      }
      if (html === null) {
        response.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end('Pass not found\n');
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(html);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/graph') {
      const campaignId = requestUrl.searchParams.get('campaignId');
      let html;
      try {
        html = observer.graph(campaignId);
      } catch (error) {
        response.writeHead(500, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(`Cannot read campaign graph: ${error.message}\n`);
        return;
      }
      if (html === null) {
        response.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end('Campaign not found\n');
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(html);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found\n');
  });
  server.once('close', () => observer.dispose());

  await new Promise((accept, reject) => {
    const onError = (error) => {
      observer.dispose();
      if (error?.code === 'EADDRINUSE') {
        reject(new Error(`port ${port} is already in use on localhost`));
      } else {
        reject(error);
      }
    };
    server.once('error', onError);
    server.listen(port, DASHBOARD_HOST, () => {
      server.off('error', onError);
      accept();
    });
  });

  const actualPort = server.address().port;
  const close = async () => {
    observer.dispose();
    if (!server.listening) return;
    await new Promise((accept, reject) => {
      server.close((error) => error ? reject(error) : accept());
    });
  };
  return {
    server,
    host: DASHBOARD_HOST,
    port: actualPort,
    url: `http://${DASHBOARD_HOST}:${actualPort}/`,
    close,
  };
}
