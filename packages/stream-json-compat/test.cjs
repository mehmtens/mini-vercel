'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const parserCompat = require('./jsonl/Parser.js');

async function main() {
  assert.equal(typeof parserCompat.make, 'function');

  const parsed = [];
  const parser = parserCompat.make();
  parser.on('data', (entry) => parsed.push(entry.value));

  await new Promise((resolve, reject) => {
    parser.once('end', resolve);
    parser.once('error', reject);
    Readable.from(['{"deployment":"ok"}\n']).pipe(parser);
  });

  assert.deepEqual(parsed, [{ deployment: 'ok' }]);
  console.log('stream-json MinIO compatibility test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
