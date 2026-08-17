import { parsePartialEventStream } from './event-stream.js';

const NODE_WIDTH = 280;
const NODE_HEIGHT = 214;
const RANK_GAP = 110;
const ROW_GAP = 34;
const MARGIN = 32;

function strings(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item !== '')
    : [];
}

function topologyUnits(events) {
  const units = new Map();
  for (const event of events) {
    if ((event?.stage !== 'campaign' && event?.stage !== 'round')
      || event.type !== 'start') continue;
    const declared = Array.isArray(event.topology?.units) ? event.topology.units : [];
    for (const unit of declared) {
      if (typeof unit?.unitId !== 'string' || unit.unitId === '') continue;
      const parents = strings(unit.parents);
      units.set(unit.unitId, {
        unitId: unit.unitId,
        unitKind: parents.length > 1 ? 'merge' : (unit.unitKind ?? null),
        parents,
        branch: typeof unit.branch === 'string' ? unit.branch : null,
        baseRef: typeof unit.baseRef === 'string' ? unit.baseRef : null,
      });
    }
  }
  return [...units.values()];
}

function initialNode(unit) {
  return {
    unitId: unit.unitId,
    unitKind: unit.unitKind,
    parents: [...unit.parents],
    isMerge: unit.parents.length > 1,
    state: 'not-dispatched',
    currentStage: null,
    gateStatus: null,
    correctnessVerdict: null,
    correctnessVerdictSource: null,
    intentVerdict: null,
    intentVerdictSource: null,
    mergedVerdict: null,
    outcome: null,
    consumedTokens: null,
    branch: unit.branch,
    baseRef: unit.baseRef,
    reason: null,
    blockedByUnitId: null,
  };
}

function eventOrder(events) {
  return events.map((event, index) => ({ event, index })).sort((left, right) => {
    const leftTime = typeof left.event?.ts === 'string' ? Date.parse(left.event.ts) : Number.NaN;
    const rightTime = typeof right.event?.ts === 'string' ? Date.parse(right.event.ts) : Number.NaN;
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.index - right.index;
  }).map(({ event }) => event);
}

function applyEvent(node, event) {
  if (event.stage === 'unit') {
    if (event.type === 'waiting') {
      node.state = 'waiting';
      node.currentStage = 'unit';
    } else if (event.type === 'released') {
      node.state = 'not-dispatched';
      node.currentStage = 'unit';
      node.reason = 'released';
      if (typeof event.baseRef === 'string') node.baseRef = event.baseRef;
    } else if (event.type === 'start') {
      node.state = 'running';
      node.currentStage = 'unit';
      node.reason = null;
      if (typeof event.baseRef === 'string') node.baseRef = event.baseRef;
      if (typeof event.branch === 'string') node.branch = event.branch;
    } else if (event.type === 'not_dispatched') {
      node.state = 'not-dispatched';
      node.currentStage = 'unit';
      node.reason = event.reason ?? null;
    } else if (event.type === 'skipped') {
      node.state = 'skipped';
      node.currentStage = 'unit';
      node.reason = event.reason ?? null;
      node.blockedByUnitId = event.blockedByUnitId ?? event.predecessorUnitId ?? null;
      node.outcome = event.blockedByOutcome ?? event.predecessorOutcome ?? 'skipped';
    } else if (event.type === 'finish') {
      node.state = 'finished';
      node.currentStage = 'unit';
      node.gateStatus = event.gateStatus ?? node.gateStatus;
      node.correctnessVerdict = event.correctnessVerdict ?? node.correctnessVerdict;
      node.correctnessVerdictSource = event.correctnessVerdictSource
        ?? node.correctnessVerdictSource;
      node.intentVerdict = event.intentVerdict ?? node.intentVerdict;
      node.intentVerdictSource = event.intentVerdictSource ?? node.intentVerdictSource;
      node.mergedVerdict = event.mergedVerdict ?? node.mergedVerdict;
      node.outcome = event.outcome ?? 'unknown';
      node.consumedTokens = event.unitConsumedTokens ?? event.consumedTokens
        ?? node.consumedTokens;
      node.branch = event.branch ?? node.branch;
      node.baseRef = event.baseRef ?? node.baseRef;
    }
    return;
  }

  if (node.state === 'finished' || node.state === 'skipped') return;
  if (['isolate', 'merge', 'executor', 'gate', 'diff', 'verify', 'report'].includes(event.stage)) {
    node.state = 'running';
    node.currentStage = event.stage;
  }
  if (event.stage === 'gate' && event.type === 'finish') {
    node.gateStatus = event.verdict ?? node.gateStatus;
  }
  // verify/* records are absent from campaign streams. This branch is intentionally
  // retained for the per-unit streams that the dashboard may add during on-demand reads.
  if (event.stage === 'verify' && event.type === 'finish') {
    if (event.pass === 'correctness') {
      node.correctnessVerdict = event.verdict ?? node.correctnessVerdict;
      node.correctnessVerdictSource = event.source ?? event.verdictSource
        ?? node.correctnessVerdictSource;
    } else if (event.pass === 'intent') {
      node.intentVerdict = event.verdict ?? node.intentVerdict;
      node.intentVerdictSource = event.source ?? event.verdictSource ?? node.intentVerdictSource;
    }
  }
  if (event.stage === 'verify' && event.type === 'verdict') {
    node.mergedVerdict = event.verdict ?? node.mergedVerdict;
  }
}

export function buildCampaignGraph(events, { unitEvents = [] } = {}) {
  if (!Array.isArray(events)) throw new TypeError('campaign events must be an array');
  if (!Array.isArray(unitEvents)) throw new TypeError('unit events must be an array');
  const declared = topologyUnits(events);
  const campaignId = events.find((event) => typeof event?.campaignId === 'string')?.campaignId
    ?? null;
  if (declared.length === 0) {
    return {
      campaignId,
      nodes: [],
      edges: [],
      message: events.length === 0
        ? 'The campaign stream has begun, but its topology is not available yet.'
        : 'This campaign did not record a declared topology, so no graph can be drawn safely.',
    };
  }

  const nodes = new Map(declared.map((unit) => [unit.unitId, initialNode(unit)]));
  for (const event of eventOrder([...events, ...unitEvents])) {
    const node = nodes.get(event?.unitId);
    if (node) applyEvent(node, event);
  }
  const orderedNodes = [...nodes.values()].sort((left, right) => (
    left.unitId.localeCompare(right.unitId)
  ));
  const edges = orderedNodes.flatMap((node) => node.parents.map((parentUnitId) => ({
    parentUnitId,
    childUnitId: node.unitId,
  }))).sort((left, right) => (
    left.parentUnitId.localeCompare(right.parentUnitId)
      || left.childUnitId.localeCompare(right.childUnitId)
  ));
  return { campaignId, nodes: orderedNodes, edges, message: null };
}

export function parseCampaignGraphStream(text, source = 'campaign-events.jsonl') {
  return buildCampaignGraph(parsePartialEventStream(text, source));
}

export function layoutCampaignGraph(graph) {
  const byId = new Map(graph.nodes.map((node) => [node.unitId, node]));
  const ranks = new Map();
  const visiting = new Set();
  const rankFor = (unitId) => {
    if (ranks.has(unitId)) return ranks.get(unitId);
    // Streams are read from disk and need not have passed scheduler validation. Returning
    // a stable rank at a back-edge prevents malformed cyclic data from recursing forever.
    if (visiting.has(unitId)) return 0;
    visiting.add(unitId);
    const node = byId.get(unitId);
    const parents = (node?.parents ?? []).filter((parent) => byId.has(parent));
    const rank = parents.length === 0 ? 0 : 1 + Math.max(...parents.map(rankFor));
    visiting.delete(unitId);
    ranks.set(unitId, rank);
    return rank;
  };
  for (const node of [...graph.nodes].sort((a, b) => a.unitId.localeCompare(b.unitId))) {
    rankFor(node.unitId);
  }

  const groups = new Map();
  for (const node of graph.nodes) {
    const rank = ranks.get(node.unitId) ?? 0;
    const group = groups.get(rank) ?? [];
    group.push(node);
    groups.set(rank, group);
  }
  for (const group of groups.values()) group.sort((a, b) => a.unitId.localeCompare(b.unitId));
  const placed = [];
  for (const rank of [...groups.keys()].sort((a, b) => a - b)) {
    groups.get(rank).forEach((node, row) => placed.push({
      ...node,
      rank,
      x: MARGIN + rank * (NODE_WIDTH + RANK_GAP),
      y: MARGIN + row * (NODE_HEIGHT + ROW_GAP),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }));
  }
  placed.sort((a, b) => a.unitId.localeCompare(b.unitId));
  const positions = new Map(placed.map((node) => [node.unitId, node]));
  const edges = graph.edges.filter((edge) => (
    positions.has(edge.parentUnitId) && positions.has(edge.childUnitId)
  )).map((edge) => {
    const parent = positions.get(edge.parentUnitId);
    const child = positions.get(edge.childUnitId);
    const startX = parent.x + parent.width;
    const startY = parent.y + parent.height / 2;
    const endX = child.x;
    const endY = child.y + child.height / 2;
    const bend = Math.max(28, (endX - startX) / 2);
    return {
      ...edge,
      path: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
    };
  });
  const maxX = placed.length === 0 ? 0 : Math.max(...placed.map((node) => node.x + node.width));
  const maxY = placed.length === 0 ? 0 : Math.max(...placed.map((node) => node.y + node.height));
  return {
    ...graph,
    nodes: placed,
    edges,
    width: maxX + MARGIN,
    height: maxY + MARGIN,
  };
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function value(value) { return value === null || value === undefined ? '—' : String(value); }

function verdict(valueToShow, source) {
  const shown = value(valueToShow);
  return source === null || source === undefined ? shown : `${shown} (${source})`;
}

function stateLabel(node) {
  if (node.state === 'waiting') return `Waiting on ${node.parents.join(', ') || 'parent'}`;
  if (node.state === 'running') return `Running · ${node.currentStage ?? 'unit'}`;
  if (node.state === 'finished') return `Finished · ${node.outcome ?? 'unknown'}`;
  if (node.state === 'skipped') return `Skipped · ${node.reason ?? 'predecessor failed'}`;
  return node.reason === 'released' ? 'Ready · not yet dispatched' : 'Not yet dispatched';
}

export function renderCampaignGraphSvg(graph) {
  const layout = Object.hasOwn(graph, 'width') ? graph : layoutCampaignGraph(graph);
  if (layout.nodes.length === 0) return '';
  const edgeMarkup = layout.edges.map((edge) => (
    `<path class="graph-edge" data-parent-unit-id="${escapeXml(edge.parentUnitId)}" `
      + `data-child-unit-id="${escapeXml(edge.childUnitId)}" d="${edge.path}"/>`
  )).join('');
  const nodeMarkup = layout.nodes.map((node) => {
    const lines = [
      stateLabel(node),
      `Kind: ${node.isMerge ? 'MERGE' : value(node.unitKind)}`,
      `Parents: ${node.parents.length ? node.parents.join(', ') : 'root'}`,
      `Gate: ${value(node.gateStatus)}`,
      `Correctness: ${verdict(node.correctnessVerdict, node.correctnessVerdictSource)}`,
      `Intent: ${verdict(node.intentVerdict, node.intentVerdictSource)}`,
      `Merged: ${value(node.mergedVerdict)}`,
      `Tokens: ${value(node.consumedTokens)}`,
      `Branch: ${value(node.branch)}`,
      `Base: ${value(node.baseRef)}`,
    ];
    const body = lines.map((line, index) => (
      `<text x="${node.x + 14}" y="${node.y + 48 + index * 15}" class="graph-node-line">${escapeXml(line)}</text>`
    )).join('');
    return `<g class="graph-node state-${escapeXml(node.state)}${node.isMerge ? ' merge-unit' : ''}" `
      + `data-unit-id="${escapeXml(node.unitId)}" data-unit-kind="${escapeXml(node.unitKind)}">`
      + `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${node.isMerge ? 2 : 10}"/>`
      + (node.isMerge
        ? `<rect class="merge-outline" x="${node.x + 5}" y="${node.y + 5}" width="${node.width - 10}" height="${node.height - 10}" rx="1"/>`
        : '')
      + `<text x="${node.x + 14}" y="${node.y + 25}" class="graph-node-title">${escapeXml(node.unitId)}</text>`
      + body + '</g>';
  }).join('');
  return `<svg class="campaign-graph" role="img" aria-label="Campaign dependency graph" `
    + `viewBox="0 0 ${layout.width} ${layout.height}" xmlns="http://www.w3.org/2000/svg">`
    + '<defs><marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>'
    + edgeMarkup + nodeMarkup + '</svg>';
}
