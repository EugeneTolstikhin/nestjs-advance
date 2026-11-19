const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

async function copied(path, expected) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, 'utf8')) === expected) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Asset was not copied: ${path}`);
}

test('Nest copies newly added views, partials and static files while preserving compiled client scripts', async () => {
  const { AssetsManager } =
    await import('../node_modules/@nestjs/cli/lib/compiler/assets-manager.js');
  const config = JSON.parse(
    await readFile(join(__dirname, '../nest-cli.json'), 'utf8'),
  );
  const directory = await mkdtemp(join(tmpdir(), 'nest-assets-'));
  const originalDirectory = process.cwd();
  const manager = new AssetsManager();
  try {
    process.chdir(directory);
    await mkdir('src/views', { recursive: true });
    await mkdir('src/public', { recursive: true });
    await mkdir('dist/public', { recursive: true });
    await writeFile('src/views/existing.hbs', '<h1>Existing</h1>');
    await writeFile('dist/public/client.js', 'compiled client script');
    config.compilerOptions.assets = config.compilerOptions.assets.filter(
      (entry) => ['views', 'public'].includes(entry),
    );
    assert.equal(config.compilerOptions.assets.length, 2);
    manager.copyAssets(config, undefined, join(directory, 'dist'), true);
    await Promise.all(manager.watcherReadyPromises);
    await copied('dist/views/existing.hbs', '<h1>Existing</h1>');
    await writeFile('src/views/orders.hbs', '<h1>My orders</h1>');
    await writeFile('src/public/orders.css', '.orders { display: grid; }');
    await mkdir('src/views/includes', { recursive: true });
    await writeFile(
      'src/views/includes/new-partial.hbs',
      '<footer>Footer</footer>',
    );
    await copied('dist/views/orders.hbs', '<h1>My orders</h1>');
    await copied('dist/public/orders.css', '.orders { display: grid; }');
    await copied(
      'dist/views/includes/new-partial.hbs',
      '<footer>Footer</footer>',
    );
    await writeFile('src/views/orders.hbs', '<h1>Updated orders</h1>');
    await copied('dist/views/orders.hbs', '<h1>Updated orders</h1>');
    assert.equal(
      await readFile('dist/public/client.js', 'utf8'),
      'compiled client script',
    );
  } finally {
    await manager.closeWatchers();
    process.chdir(originalDirectory);
    await rm(directory, { recursive: true, force: true });
  }
});
