import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCampaign } from '../src/campaign.js';
import {
  buildCampaignGraph,
  layoutCampaignGraph,
  parseCampaignGraphStream,
  renderCampaignGraphSvg,
} from '../src/campaign-graph.js';

function startEvent(units, campaignId = 'graph-campaign') {
  return {
    ts: '2026-08-15T00:00:00.000Z',
    runId: campaignId,
    campaignId,
    round: 1,
    unitId: null,
    unitKind: null,
    stage: 'campaign',
    type: 'start',
    topology: {
      units,
      edges: units.flatMap((unit) => unit.parents.map((parentUnitId) => ({
        parentUnitId,
        childUnitId: unit.unitId,
      }))),
    },
  };
}

function unitEvent(unitId, type, fields = {}) {
  return {
    ts: fields.ts ?? '2026-08-15T00:00:01.000Z',
    runId: unitId,
    campaignId: 'graph-campaign',
    round: 1,
    unitId,
    unitKind: 'node',
    stage: 'unit',
    type,
    ...fields,
  };
}

test('graph keeps correctness and intent verdicts separate when only intent has issues', async () => {
  const events = [];
  await runCampaign({
    campaignId: 'verdict-provenance',
    tasks: [{ task: 'review this unit', unitId: 'run-31-shape', unitKind: 'node' }],
    target: 'adapter-target',
    gate: [],
    concurrency: 1,
    tokenBudget: 1000,
    reporter: (event) => events.push(event),
    runUnit: async ({ runId }) => ({
      runId,
      outcome: 'review-ready',
      gateStatus: 'passed',
      correctnessVerdict: 'NO_BLOCKERS',
      correctnessVerdictSource: 'result',
      intentVerdict: 'ISSUES',
      intentVerdictSource: 'result',
      verdict: 'ISSUES',
      verdictSource: 'result',
      branch: `ccc/${runId}`,
      baseRef: 'HEAD',
      tokens: { total: {} },
    }),
  });

  const finish = events.find((event) => event.stage === 'unit' && event.type === 'finish');
  assert.deepEqual({
    correctnessVerdict: finish.correctnessVerdict,
    correctnessVerdictSource: finish.correctnessVerdictSource,
    intentVerdict: finish.intentVerdict,
    intentVerdictSource: finish.intentVerdictSource,
    mergedVerdict: finish.mergedVerdict,
  }, {
    correctnessVerdict: 'NO_BLOCKERS', correctnessVerdictSource: 'result',
    intentVerdict: 'ISSUES', intentVerdictSource: 'result', mergedVerdict: 'ISSUES',
  });
  const node = buildCampaignGraph(events).nodes[0];
  assert.equal(node.correctnessVerdict, 'NO_BLOCKERS');
  assert.equal(node.intentVerdict, 'ISSUES');
  assert.equal(node.mergedVerdict, 'ISSUES');
});

test('campaign start records every resolved edge even when one merge parent finishes first', async () => {
  const events = [];
  await runCampaign({
    campaignId: 'declared-edges',
    tasks: [
      { task: 'fast parent', unitId: 'fast', unitKind: 'node' },
      { task: 'slow parent', unitId: 'slow', unitKind: 'node' },
      { task: 'combine', unitId: 'combine', dependsOn: ['fast', 'slow'], unitKind: 'node' },
    ],
    target: 'adapter-target',
    gate: [],
    concurrency: 2,
    tokenBudget: 1000,
    reporter: (event) => events.push(event),
    runUnit: async ({ runId }) => {
      if (runId === 'slow') await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        runId, outcome: 'no-op', gateStatus: 'passed', branch: `ccc/${runId}`,
        baseRef: 'HEAD', tokens: { total: {} },
      };
    },
  });

  const start = events.find((event) => event.stage === 'campaign' && event.type === 'start');
  assert.deepEqual(start.topology.edges, [
    { parentUnitId: 'fast', childUnitId: 'combine' },
    { parentUnitId: 'slow', childUnitId: 'combine' },
  ]);
  assert.equal(start.topology.units.find((unit) => unit.unitId === 'combine').unitKind, 'merge');
  const fastFinish = events.findIndex((event) => (
    event.unitId === 'fast' && event.stage === 'unit' && event.type === 'finish'
  ));
  const slowFinish = events.findIndex((event) => (
    event.unitId === 'slow' && event.stage === 'unit' && event.type === 'finish'
  ));
  assert.ok(fastFinish >= 0 && fastFinish < slowFinish,
    'positive control: the fast parent must finish while the merge still waits on slow');

  const reconstructFromSingleRelease = events
    .filter((event) => event.stage === 'unit' && event.type === 'released'
      && typeof event.predecessorUnitId === 'string')
    .map((event) => ({
      parentUnitId: event.predecessorUnitId,
      childUnitId: event.unitId,
    }));
  assert.equal(reconstructFromSingleRelease.some((edge) => (
    edge.parentUnitId === 'fast' && edge.childUnitId === 'combine'
  )), false, 'positive control: reconstructing only single-parent release records loses the edge');
  assert.notDeepEqual(reconstructFromSingleRelease, start.topology.edges);
});

test('diamond fan-in preserves the exact parent-child pairs and missing one changes the drawing', () => {
  const units = [
    { unitId: 'root', unitKind: 'node', parents: [] },
    { unitId: 'left', unitKind: 'node', parents: ['root'] },
    { unitId: 'right', unitKind: 'node', parents: ['root'] },
    { unitId: 'join', unitKind: 'merge', parents: ['left', 'right'] },
  ];
  const graph = buildCampaignGraph([startEvent(units)]);
  assert.deepEqual(graph.edges, [
    { parentUnitId: 'left', childUnitId: 'join' },
    { parentUnitId: 'right', childUnitId: 'join' },
    { parentUnitId: 'root', childUnitId: 'left' },
    { parentUnitId: 'root', childUnitId: 'right' },
  ]);
  const svg = renderCampaignGraphSvg(graph);
  for (const [parent, child] of [
    ['root', 'left'], ['root', 'right'], ['left', 'join'], ['right', 'join'],
  ]) {
    assert.match(svg, new RegExp(`data-parent-unit-id="${parent}" data-child-unit-id="${child}"`));
  }

  const missing = units.map((unit) => unit.unitId === 'join'
    ? { ...unit, parents: ['left'] }
    : unit);
  const missingSvg = renderCampaignGraphSvg(buildCampaignGraph([startEvent(missing)]));
  assert.notEqual(missingSvg, svg);
  assert.doesNotMatch(missingSvg,
    /data-parent-unit-id="right" data-child-unit-id="join"/);
});

test('merge promotion is visible while a one-parent unit remains ordinary', () => {
  const graph = buildCampaignGraph([startEvent([
    { unitId: 'a', unitKind: 'node', parents: [] },
    { unitId: 'b', unitKind: 'node', parents: ['a'] },
    { unitId: 'c', unitKind: 'node', parents: ['a', 'b'] },
  ])]);
  assert.equal(graph.nodes.find((node) => node.unitId === 'c').isMerge, true);
  assert.equal(graph.nodes.find((node) => node.unitId === 'c').unitKind, 'merge');
  assert.equal(graph.nodes.find((node) => node.unitId === 'b').isMerge, false);
  const svg = renderCampaignGraphSvg(graph);
  assert.match(svg, /data-unit-id="c" data-unit-kind="merge"/);
  assert.match(svg, /class="merge-outline"/);
  assert.doesNotMatch(svg, /data-unit-id="b" data-unit-kind="node"[^]*class="merge-outline"[^]*data-unit-id="c"/);
});

test('waiting, running, finished, skipped, and unreached nodes remain distinct', () => {
  const topology = startEvent([
    { unitId: 'unreached', unitKind: 'node', parents: [] },
    { unitId: 'waiting', unitKind: 'node', parents: ['unreached'] },
    { unitId: 'running', unitKind: 'node', parents: [] },
    { unitId: 'finished', unitKind: 'node', parents: [] },
    { unitId: 'skipped', unitKind: 'node', parents: ['finished'] },
  ]);
  const graph = buildCampaignGraph([
    topology,
    unitEvent('waiting', 'waiting', { predecessorUnitId: 'unreached' }),
    unitEvent('running', 'start'),
    unitEvent('finished', 'start'),
    unitEvent('finished', 'finish', {
      ts: '2026-08-15T00:00:03.000Z', outcome: 'review-ready', gateStatus: 'passed',
      correctnessVerdict: 'NO_BLOCKERS', correctnessVerdictSource: 'result',
      intentVerdict: 'NO_BLOCKERS', intentVerdictSource: 'result',
      mergedVerdict: 'NO_BLOCKERS', consumedTokens: 42,
      branch: 'ccc/finished', baseRef: 'main',
    }),
    unitEvent('skipped', 'skipped', {
      ts: '2026-08-15T00:00:04.000Z', reason: 'predecessor-failed',
      blockedByUnitId: 'finished', blockedByOutcome: 'gate-failed',
    }),
  ], {
    unitEvents: [{
      ts: '2026-08-15T00:00:02.000Z', runId: 'running', unitId: 'running',
      stage: 'gate', type: 'start',
    }],
  });
  const states = Object.fromEntries(graph.nodes.map((node) => [node.unitId, node.state]));
  assert.deepEqual(states, {
    finished: 'finished', running: 'running', skipped: 'skipped',
    unreached: 'not-dispatched', waiting: 'waiting',
  });
  assert.notEqual(states.waiting, states.unreached,
    'a blocked unit must not collapse into a unit the scheduler never reached');
  assert.equal(graph.nodes.find((node) => node.unitId === 'running').currentStage, 'gate');
  const finished = graph.nodes.find((node) => node.unitId === 'finished');
  assert.deepEqual({
    gateStatus: finished.gateStatus,
    correctnessVerdict: finished.correctnessVerdict,
    intentVerdict: finished.intentVerdict,
    mergedVerdict: finished.mergedVerdict,
    outcome: finished.outcome,
    consumedTokens: finished.consumedTokens,
    branch: finished.branch,
    baseRef: finished.baseRef,
  }, {
    gateStatus: 'passed', correctnessVerdict: 'NO_BLOCKERS',
    intentVerdict: 'NO_BLOCKERS', mergedVerdict: 'NO_BLOCKERS',
    outcome: 'review-ready', consumedTokens: 42,
    branch: 'ccc/finished', baseRef: 'main',
  });
  assert.equal(graph.nodes.find((node) => node.unitId === 'skipped').blockedByUnitId,
    'finished');
});

test('layout and SVG are deterministic, and malformed cycles are guarded', () => {
  const graph = buildCampaignGraph([startEvent([
    { unitId: 'z-root', unitKind: 'node', parents: [] },
    { unitId: 'a-root', unitKind: 'node', parents: [] },
    { unitId: 'child', unitKind: 'merge', parents: ['z-root', 'a-root'] },
  ])]);
  assert.deepEqual(layoutCampaignGraph(graph), layoutCampaignGraph(graph));
  assert.equal(renderCampaignGraphSvg(graph), renderCampaignGraphSvg(graph));

  const cyclic = buildCampaignGraph([startEvent([
    { unitId: 'cycle-a', unitKind: 'node', parents: ['cycle-b'] },
    { unitId: 'cycle-b', unitKind: 'node', parents: ['cycle-a'] },
  ])]);
  assert.doesNotThrow(() => layoutCampaignGraph(cyclic));
  assert.equal(renderCampaignGraphSvg(cyclic), renderCampaignGraphSvg(cyclic));
});

test('partial final records are ignored and an only-begun stream has an explanation', () => {
  const start = startEvent([{ unitId: 'only', unitKind: 'node', parents: [] }]);
  const graph = parseCampaignGraphStream(`${JSON.stringify(start)}\n{"stage":"unit"`);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].state, 'not-dispatched');
  assert.equal(buildCampaignGraph([]).message,
    'The campaign stream has begun, but its topology is not available yet.');
  assert.match(buildCampaignGraph([{ stage: 'campaign', type: 'start' }]).message,
    /did not record a declared topology/);
});
