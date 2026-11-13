const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

// npm's script shell can prepend an fnm runtime after `nvm use`. Honor the
// explicit nvm selection first, then inspect npm's runtime and our own binary.
function resolveNodeRuntime(env = process.env, currentNode = process.execPath) {
  const candidates = [
    ...new Set(
      [
        env.NVM_BIN ? join(env.NVM_BIN, 'node') : undefined,
        env.npm_node_execpath,
        currentNode,
      ].filter(Boolean),
    ),
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-p', 'process.version'], {
      env,
      encoding: 'utf8',
      timeout: 3000,
    });
    if (probe.status === 0 && /^v24\./.test(probe.stdout.trim()))
      return candidate;
  }
  throw new Error(
    `No selected Node 24 runtime was found. The launcher is running from ${currentNode}. Run "nvm use" in this terminal; NVM_BIN must point to the selected Node 24 installation.`,
  );
}
module.exports = { resolveNodeRuntime };
