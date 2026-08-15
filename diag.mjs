import { spawnCapture } from './src/spawn.js';
import { buildCursorArgs } from './src/verifier.js';
const args = buildCursorArgs({ prompt: 'Read CHANGES.diff and list concrete bugs as file:line - sentence. If none, reply NO_BLOCKERS.' });
const r = await spawnCapture('agent', args, { cwd: process.argv[2] });
console.log('EXIT:', r.code, '| stdout bytes:', r.stdout.length, '| stderr:', r.stderr.slice(0,300));
const types = {};
for (const l of r.stdout.split('\n')) { const s=l.trim(); if(!s) continue;
  try{ const o=JSON.parse(s); types[o.type]=(types[o.type]||0)+1; }catch{} }
console.log('event types:', JSON.stringify(types));
for (const l of r.stdout.split('\n')) { const s=l.trim(); if(!s) continue;
  try{ const o=JSON.parse(s);
    if(o.type==='result') console.log('RESULT is_error=',o.is_error,'text:', String(o.result).slice(0,1500));
  }catch{} }
