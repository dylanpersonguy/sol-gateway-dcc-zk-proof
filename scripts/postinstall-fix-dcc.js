#!/usr/bin/env node
/**
 * Postinstall fix for @decentralchain/decentralchain-transactions
 * 
 * The package uses extensionless ESM imports for @decentralchain/node-api-js CJS paths,
 * which Node.js strict ESM resolver rejects. This script adds .js extensions.
 */
const fs = require('fs');
const path = require('path');

const target = path.join(
  __dirname,
  '..',
  'node_modules',
  '@decentralchain',
  'decentralchain-transactions',
  'dist',
  'index.js'
);

if (!fs.existsSync(target)) {
  console.log('[postinstall] DCC transactions dist not found, skipping fix');
  process.exit(0);
}

let content = fs.readFileSync(target, 'utf-8');

const replacements = [
  ["/cjs/tools/request'", "/cjs/tools/request.js'"],
  ["/cjs/tools/stringify'", "/cjs/tools/stringify.js'"],
  ["/cjs/api-node/transactions'", "/cjs/api-node/transactions/index.js'"],
  ["/cjs/api-node/blocks'", "/cjs/api-node/blocks/index.js'"],
  ["/cjs/api-node/addresses'", "/cjs/api-node/addresses/index.js'"],
  ["/cjs/api-node/assets'", "/cjs/api-node/assets/index.js'"],
  ["/cjs/api-node/rewards'", "/cjs/api-node/rewards/index.js'"],
  ["/cjs/api-node/debug'", "/cjs/api-node/debug/index.js'"],
];

let patched = 0;
for (const [from, to] of replacements) {
  if (content.includes(from)) {
    content = content.replaceAll(from, to);
    patched++;
  }
}

if (patched > 0) {
  fs.writeFileSync(target, content);
  console.log(`[postinstall] Patched ${patched} ESM imports in DCC transactions`);
} else {
  console.log('[postinstall] DCC transactions imports already patched');
}
