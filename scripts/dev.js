import { spawn } from 'node:child_process';

const children = [];
let shuttingDown = false;
function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  process.exitCode = code;
}

async function apiIsHealthy() {
  try {
    const response = await fetch('http://127.0.0.1:4000/api/health', { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const health = await response.json();
    return health.success === true && health.database === 'connected';
  } catch {
    return false;
  }
}

function watch(child, name) {
  children.push(child);
  child.on('error', error => {
    console.error(`Could not start ${name}:`, error.message);
    stop(1);
  });
  child.on('exit', code => {
    if (!shuttingDown) {
      console.error(`${name} exited with code ${code ?? 'unknown'}; stopping the other development service.`);
      stop(code ?? 1);
    }
  });
}

if (await apiIsHealthy()) {
  console.log('Reusing the CAFlow API already running on port 4000.');
} else {
  watch(spawn(process.execPath, ['server/index.js'], { stdio: 'inherit', env: process.env }), 'CAFlow API');
}
watch(spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0'], { stdio: 'inherit', env: process.env }), 'Vite frontend');

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
