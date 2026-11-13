const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join, dirname, delimiter } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const { resolveNodeRuntime } = require('../scripts/node-runtime.cjs');
let directory, wrongNode;
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'node-runtime-'));
  mkdirSync(join(directory, 'bin'));
  wrongNode = join(directory, 'bin', 'node');
  writeFileSync(wrongNode, '#!/bin/sh\nprintf "v26.7.0\\n"\n', { mode: 0o755 });
});
after(() => rmSync(directory, { recursive: true, force: true }));
test('honors NVM_BIN when npm and the launcher use another runtime, including SQLite reads/writes', () => {
  const env = { ...process.env, NVM_BIN: dirname(process.execPath), npm_node_execpath: wrongNode, PATH: `${dirname(wrongNode)}${delimiter}${process.env.PATH}` };
  const selected = resolveNodeRuntime(env, wrongNode);
  assert.equal(selected, process.execPath);
  const output = execFileSync(selected, ['-e', `const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});const db=new D(':memory:');db.exec('CREATE TABLE probe (value INTEGER)');db.prepare('INSERT INTO probe VALUES (?)').run(1);console.log(JSON.stringify({version:process.version,abi:process.versions.modules,value:db.prepare('SELECT value FROM probe').get().value}));db.close();`], { env, encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.match(result.version, /^v24\./); assert.equal(result.abi, '137'); assert.equal(result.value, 1);
});
test('falls back to npm’s verified Node runtime when nvm is not selected', () => {
  assert.equal(resolveNodeRuntime({ ...process.env, NVM_BIN: '', npm_node_execpath: process.execPath }, wrongNode), process.execPath);
});
test('fails clearly when every selected runtime is incompatible', () => {
  assert.throws(() => resolveNodeRuntime({ ...process.env, NVM_BIN: dirname(wrongNode), npm_node_execpath: wrongNode }, wrongNode), /No selected Node 24/);
});
