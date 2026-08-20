import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.URO_FAKE_DOCTOR_INVOCATIONS) {
  appendFileSync(process.env.URO_FAKE_DOCTOR_INVOCATIONS, `${JSON.stringify({ cli: 'agent', args })}\n`);
}

if (args[0] === 'status') {
  if (process.env.URO_FAKE_AGENT_SIGNED_IN === 'no') {
    process.stderr.write('Not logged in\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('✓ Logged in as test@example.com\n');
  }
} else {
  const content = readFileSync('ccc-doctor-read.txt', 'utf8');
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: content,
  })}\n`);
}
