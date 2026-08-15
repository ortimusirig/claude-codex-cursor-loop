import { readFileSync } from 'node:fs';

const content = readFileSync('ccc-doctor-read.txt', 'utf8');
process.stdout.write(`${JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: content,
})}\n`);

