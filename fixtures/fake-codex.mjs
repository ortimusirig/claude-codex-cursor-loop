// Emits newline-delimited JSON events shaped like the REAL `codex exec --json` stream.
const events = [
  { type: 'thread.started' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: 'a.py', kind: 'add' }], status: 'completed' } },
  { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'b.py', kind: 'add' }], status: 'completed' } },
  { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'implemented the thing' } },
  { type: 'turn.completed' },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + '\n');
