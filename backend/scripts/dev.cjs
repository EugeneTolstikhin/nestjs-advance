// Keep browser compilation separate from Nest's server compiler. Both watch
// processes share dist, so the development server must not delete that folder.
const { spawn, spawnSync } = require('node:child_process');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

process.chdir(join(__dirname, '..'));
const tsc = require.resolve('typescript/bin/tsc');
const nest = require.resolve('@nestjs/cli/bin/nest.js');
const initial = spawnSync(
  process.execPath,
  [tsc, '-p', 'tsconfig.client.json'],
  { stdio: 'inherit' },
);
if (initial.status !== 0) process.exit(initial.status ?? 1);

const config = JSON.parse(readFileSync('nest-cli.json', 'utf8'));
config.compilerOptions.deleteOutDir = false;
mkdirSync('.tmp', { recursive: true });
const configPath = '.tmp/nest-cli.dev.json';
writeFileSync(configPath, JSON.stringify(config));

const children = [
  spawn(
    process.execPath,
    [tsc, '-p', 'tsconfig.client.json', '--watch', '--preserveWatchOutput'],
    { stdio: 'inherit' },
  ),
  spawn(
    process.execPath,
    [
      nest,
      'start',
      '--watch',
      '--config',
      configPath,
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit' },
  ),
];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  children.forEach((child) => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
}
children.forEach((child) => {
  child.on('error', (error) => {
    console.error(error);
    stop(1);
  });
  child.on('exit', (code) => stop(code ?? 1));
});
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
