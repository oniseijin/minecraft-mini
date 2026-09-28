#!/usr/bin/env node
/**
 * `npm run dev:all` — runs the game server (tsx watch) and the Vite dev client
 * side by side with prefixed, color-coded output. Ctrl-C (or the death of
 * either child) tears down both, so there are no orphaned processes left on
 * :5173 / :6881.
 */
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const COLORS = { '[server]': '\x1b[36m', '[client]': '\x1b[35m' }; // cyan / magenta
const RESET = '\x1b[0m';

const children = [];
let shuttingDown = false;

function prefixFor(name) {
  return COLORS[name] ? `${COLORS[name]}${name}${RESET}` : name;
}

/** Spawn one `npm run <script>` child, tagging every output line with its name. */
function run(name, script) {
  const child = spawn(npm, ['run', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32', // own process group → clean group kill
  });

  const tag = (line) => `${prefixFor(name)} ${line}`;
  for (const stream of ['stdout', 'stderr']) {
    let buffer = '';
    child[stream].setEncoding('utf8');
    child[stream].on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) process.stdout.write(`${tag(line)}\n`);
        newline = buffer.indexOf('\n');
      }
    });
  }

  child.on('exit', (code, signal) => {
    process.stdout.write(`${tag(`(${script} exited: ${signal ?? `code ${code}`})`)}\n`);
    shutdown();
  });

  children.push(child);
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      if (child.pid !== undefined && !child.killed) {
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid, 'SIGTERM'); // negative pid = whole group
      }
    } catch {
      // already gone
    }
  }
  // Escalate to SIGKILL if a child ignores SIGTERM.
  setTimeout(() => {
    for (const child of children) {
      try {
        if (child.pid !== undefined && !child.killed && process.platform !== 'win32') {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        // already gone
      }
    }
    process.exit(0);
  }, 1500).unref();
  setTimeout(() => process.exit(0), 1800).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.stdout.write(`${prefixFor('[dev:all]')} starting server + client (Ctrl-C stops both)\n`);
run('[server]', 'dev:server');
run('[client]', 'dev');
