const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(__dirname, '../tsconfig.json')], { cwd: join(__dirname, '..'), stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
require('./copy-assets.cjs');
require('../dist/main.js');
