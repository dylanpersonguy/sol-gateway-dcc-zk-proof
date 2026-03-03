import { readFileSync } from 'fs';

const NODES = [
  'https://keough-node.decentralchain.io',
  'https://nodes.decentralchain.io',
  'https://dcc-node.example.com',
];

const test_v5 = `{-# STDLIB_VERSION 5 #-}
{-# CONTENT_TYPE DAPP #-}
{-# SCRIPT_TYPE ACCOUNT #-}
@Callable(i)
func hello() = []`;

const test_v6 = `{-# STDLIB_VERSION 6 #-}
{-# CONTENT_TYPE DAPP #-}
{-# SCRIPT_TYPE ACCOUNT #-}
@Callable(i)
func hello() = []`;

for (const node of NODES.slice(0, 2)) {
  for (const [ver, script] of [['v5', test_v5], ['v6', test_v6]]) {
    try {
      const resp = await fetch(`${node}/utils/script/compileCode`, {
        method: 'POST',
        headers: {'Content-Type': 'text/plain'},
        body: script,
        signal: AbortSignal.timeout(15000),
      });
      const text = await resp.text();
      let json;
      try { json = JSON.parse(text); } catch { json = {raw: text.slice(0, 200)}; }
      const ok = json.script ? 'OK' : ('FAIL: ' + JSON.stringify(json).slice(0, 120));
      console.log(`${node} [${ver}]: ${ok}`);
    } catch (e) {
      console.log(`${node} [${ver}]: ERROR: ${e.message}`);
    }
  }
  console.log();
}

// Also check node version
for (const node of NODES.slice(0, 2)) {
  try {
    const r = await fetch(`${node}/node/version`, {signal: AbortSignal.timeout(10000)});
    const d = await r.json();
    console.log(`${node} version: ${JSON.stringify(d)}`);
  } catch(e) {
    console.log(`${node} version: ${e.message}`);
  }
}
