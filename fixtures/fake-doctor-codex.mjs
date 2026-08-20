import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.URO_FAKE_DOCTOR_INVOCATIONS) {
  appendFileSync(process.env.URO_FAKE_DOCTOR_INVOCATIONS, `${JSON.stringify({ cli: 'codex', args })}\n`);
}

if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.URO_FAKE_CODEX_SIGNED_IN === 'no') {
    process.stderr.write('Not logged in\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('Logged in using ChatGPT\n');
  }
} else {
  writeFileSync('ccc-doctor-write.txt', 'URO_DOCTOR_WRITE_OK\n');
  process.stdout.write(`${JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'file_change',
      changes: [{ path: 'ccc-doctor-write.txt', kind: 'add' }],
    },
  })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);
}
