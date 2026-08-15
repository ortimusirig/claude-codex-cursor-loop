import { writeFileSync } from 'node:fs';

writeFileSync('observed.txt', 'written by fake codex\n');
const events = [
  { type: 'thread.started' },
  { type: 'turn.started' },
  {
    type: 'item.completed',
    item: {
      id: 'writer-1',
      type: 'file_change',
      changes: [{ path: 'observed.txt', kind: 'add' }],
      status: 'completed',
    },
  },
  {
    type: 'item.completed',
    item: { id: 'writer-2', type: 'agent_message', text: 'wrote observed.txt' },
  },
  { type: 'turn.completed' },
];
for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
