import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { runExecutor } from '../src/executor.js';
import { createGapWatchdog } from '../src/stall-watchdog.js';

function executorWithWatchdog({ source, thresholdMs, runId }) {
  const delivered = [];
  const watchdog = createGapWatchdog({
    reporter: (event) => delivered.push(event),
    runId,
    thresholdMs,
  });
  const pending = runExecutor({
    plan: 'watch the stream', cwd: tmpdir(),
    bin: process.execPath, extraArgv: ['-e', source],
    reporter: watchdog.reporter, runId, attempt: 1, timeoutMs: 5000,
  });
  return { delivered, watchdog, pending };
}

test('a healthy executor outliving the threshold stays unstalled when items keep completing',
  async () => {
    const thresholdMs = 750;
    const source = [
      'let index = 0',
      'const emit = () => {',
      '  const detail = index === 0',
      '    ? {type:"file_change",changes:[{path:"file-0.js"}]}',
      '    : {type:"command_execution",command:`command-${index}`}',
      '  const item = {type:"item.completed",item:detail}',
      '  process.stdout.write(JSON.stringify(item) + "\\n")',
      '  index++',
      '  if (index < 6) setTimeout(emit, 200)',
      '}',
      'emit()',
    ].join('\n');
    const started = Date.now();
    const { delivered, watchdog, pending } = executorWithWatchdog({
      source, thresholdMs, runId: 'healthy-executor',
    });
    try {
      const result = await pending;
      assert.equal(result.exitCode, 0, 'positive setup: the active executor must finish normally');
      assert.ok(Date.now() - started > thresholdMs,
        'positive setup: total executor duration must exceed the watchdog threshold');
      assert.equal(delivered.filter((event) => event.type === 'file_change').length, 1,
        'positive setup: a completed file change must reach the watchdog');
      assert.equal(delivered.filter((event) => event.type === 'item_completed').length, 5,
        'other completed items must also count as real intra-stage progress');
      assert.equal(delivered.some((event) => event.type === 'stalled'), false,
        'steady executor items must reset the gap timer');
    } finally {
      watchdog.dispose();
    }
  });

test('a genuinely silent executor still emits one stall event', async () => {
  const { delivered, watchdog, pending } = executorWithWatchdog({
    source: 'setTimeout(() => {}, 350)', thresholdMs: 100, runId: 'silent-executor',
  });
  try {
    await pending;
    const stalls = delivered.filter((event) => event.type === 'stalled');
    assert.equal(stalls.length, 1,
      'silence must still fire once; the incremental fix cannot merely disable the watchdog');
    assert.equal(stalls[0].stage, 'executor');
    assert.equal(stalls[0].lastEvent.type, 'start');
  } finally {
    watchdog.dispose();
  }
});
