import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WINDOWS_TREE_SCRIPT = fileURLToPath(new URL('./windows-process-tree.ps1', import.meta.url));

// Resolve a bare command name to a full path via `where` (win) / `which` (posix).
// A bin that already carries a path separator is returned as-is when it exists.
// Returns null when it cannot be resolved.
function resolveBin(bin) {
  if (bin.includes('/') || bin.includes('\\')) {
    return Promise.resolve(existsSync(bin) ? bin : null);
  }
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((res) => {
    const c = spawn(probe, [bin], { windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', () => res(null));
    c.on('close', (code) => {
      if (code !== 0) return res(null);
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (process.platform === 'win32') {
        // `where` may list an extensionless shim (e.g. npm's `codex`) BEFORE the runnable
        // `codex.cmd`; prefer a PATHEXT-executable variant Windows can actually launch.
        const exe = lines.find((l) => /\.(exe|cmd|bat|com)$/i.test(l));
        return res(exe || lines[0] || null);
      }
      return res(lines[0] || null);
    });
  });
}

// Quote a token for a cmd.exe command line: wrap in double quotes if it holds
// whitespace or a quote (doubling any internal quote); empty string -> "".
function quoteWin(s) {
  if (s === '') return '""';
  if (/[\s"]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function killWindowsTreeFallback(child) {
  const inspector = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', WINDOWS_TREE_SCRIPT, String(child.pid),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const pids = output.trim() === '' ? [] : output.trim().split(/\s+/).map(Number);
    for (const pid of pids.filter((value) => Number.isInteger(value) && value > 0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* process already exited */ }
    }
    child.kill();
  };
  const timer = setTimeout(() => { inspector.kill(); finish(); }, 10_000);
  inspector.stdout.on('data', (chunk) => { output += chunk; });
  inspector.on('error', () => { clearTimeout(timer); finish(); });
  inspector.on('close', () => { clearTimeout(timer); finish(); });
}

function killProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // A .cmd/.bat launch runs behind cmd.exe. Killing only that wrapper can leave
    // its real child alive, so taskkill /T is required to terminate the full tree.
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    let fallbackStarted = false;
    const fallback = () => {
      if (fallbackStarted) return;
      fallbackStarted = true;
      killWindowsTreeFallback(child);
    };
    const timer = setTimeout(() => { killer.kill(); fallback(); }, 5000);
    killer.on('error', () => { clearTimeout(timer); fallback(); });
    killer.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) fallback();
    });
    return;
  }
  try {
    // Timed POSIX launches get their own process group below, so descendants die too.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export async function spawnCapture(bin, args, opts = {}) {
  const timeoutMs = opts.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }
  let cmd = bin;
  let cmdArgs = args;
  let verbatim = false;
  if (process.platform === 'win32') {
    const resolved = await resolveBin(bin);
    if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
      // Node cannot exec .cmd/.bat directly (CVE-2024-27980), and `shell:true`
      // RE-SPLITS args (`a b c` -> three args). Spawn cmd.exe (an .exe) directly and
      // build the command line ourselves with windowsVerbatimArguments: wrap the WHOLE
      // command in one extra outer quote pair so `cmd /s` strips exactly that pair,
      // leaving a correctly-quoted "path" + args — this survives spaces in the path
      // (e.g. the OneDrive package path), which a plain quoted `cmd /c "x" "a b"` mangles.
      // (Known cmd limit: a .cmd reading an `=`-bearing arg via %~1 splits on `=`; our
      // .cmd targets carry no `=` args — the only `=` argv, codex `mcp_servers={}`, goes
      // to codex.exe, spawned directly.)
      cmd = process.env.ComSpec || 'cmd.exe';
      const line = '"' + [resolved, ...args].map(quoteWin).join(' ') + '"';
      cmdArgs = ['/d', '/s', '/c', line];
      verbatim = true;
    } else if (resolved) {
      cmd = resolved;
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      detached: timeoutMs !== undefined && process.platform !== 'win32',
    });
    const outChunks = [];
    const errChunks = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer = timeoutMs === undefined ? null : setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    const signal = opts.signal;
    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      if (timer) { clearTimeout(timer); timer = null; }
      killProcessTree(child);
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    child.stdout.on('data', (d) => {
      outChunks.push(d);
      if (typeof opts.onStdout === 'function') {
        try {
          // Observation is additive: keep the vendor-owned chunk in the capture and hand
          // observers a copy, so mutation or failure cannot change returned stdout.
          const observed = opts.onStdout(Buffer.from(d));
          if (observed && typeof observed.catch === 'function') observed.catch(() => {});
        } catch {
          // Capture is part of the run; an optional observer is disposable.
        }
      }
    });
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!settled) { settled = true; reject(error); }
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      resolve({
        code: code ?? -1,
        signal: signal ?? null,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        timedOut,
        ...(opts.signal ? { aborted } : {}),
        timeoutMs: timeoutMs ?? null,
      });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export async function commandExists(bin) {
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin);
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = await spawnCapture(probe, [bin]);
    return r.code === 0;
  } catch {
    return false;
  }
}
