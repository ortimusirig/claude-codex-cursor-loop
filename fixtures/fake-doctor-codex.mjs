import { writeFileSync } from 'node:fs';

writeFileSync('ccc-doctor-write.txt', 'CCC_DOCTOR_WRITE_OK\n');
process.stdout.write(`${JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'file_change',
    changes: [{ path: 'ccc-doctor-write.txt', kind: 'add' }],
  },
})}\n`);
process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);

