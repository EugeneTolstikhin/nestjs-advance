const { cpSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
mkdirSync(join(root, 'dist/views'), { recursive: true });
cpSync(join(root, 'src/views'), join(root, 'dist/views'), { recursive: true });
