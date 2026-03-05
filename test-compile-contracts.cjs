const fs = require("fs");

async function testCompile(name, path) {
  const code = fs.readFileSync(path, "utf8");
  const r = await fetch("https://mainnet-node.decentralchain.io/utils/script/compileCode", {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-API-Key": "***REDACTED_API_KEY***" },
    body: code,
  });
  const d = await r.json();
  if (d.script) {
    console.log(name + " compiled OK:", Math.round(d.script.length * 3 / 4), "bytes");
    console.log("  Complexity:", d.complexity || "N/A");
    console.log("  ExtraFee:", d.extraFee || "N/A");
  } else {
    console.log(name + " COMPILE ERROR:", d.message || JSON.stringify(d));
  }
}

async function main() {
  await testCompile("Contract A (zk_bridge.ride)", "dcc/contracts/bridge/zk_bridge.ride");
  console.log();
  await testCompile("Contract B (zk_verifier.ride)", "dcc/contracts/bridge/zk_verifier.ride");
}

main().catch(e => console.error(e));
