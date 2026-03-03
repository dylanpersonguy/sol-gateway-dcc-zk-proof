#!/usr/bin/env ts-node

/**
 * deploy-dcc-contracts.ts
 *
 * Deploys the bridge controller and wSOL token contracts to DecentralChain.
 *
 * Usage:
 *   ts-node scripts/deploy-dcc-contracts.ts \
 *     --network testnet \
 *     --bridge-controller dcc-contracts/bridge-controller/bridge_controller.ride \
 *     --wsol-token dcc-contracts/wsol-token/wsol_token.ride
 */

import * as fs from "fs";
import axios from "axios";

interface Args {
  network: string;
  bridgeControllerPath: string;
  wsolTokenPath: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (key: string): string => {
    const idx = argv.indexOf(key);
    if (idx === -1 || idx + 1 >= argv.length) {
      throw new Error(`Missing argument: ${key}`);
    }
    return argv[idx + 1];
  };

  return {
    network: get("--network"),
    bridgeControllerPath: get("--bridge-controller"),
    wsolTokenPath: get("--wsol-token"),
  };
}

async function compileRideScript(
  nodeUrl: string,
  script: string
): Promise<string> {
  // DCC nodes expose a /utils/script/compileCode endpoint
  const resp = await axios.post(`${nodeUrl}/utils/script/compileCode`, script, {
    headers: { "Content-Type": "text/plain" },
  });
  return resp.data.script;
}

async function main() {
  const args = parseArgs();

  const nodeUrls: Record<string, string> = {
    testnet: "https://testnet.decentralchain.io",
    mainnet: "https://nodes.decentralchain.io",
  };
  const nodeUrl = nodeUrls[args.network];
  if (!nodeUrl) throw new Error(`Unknown network: ${args.network}`);

  console.log("=== Deploy DCC Bridge Contracts ===");
  console.log("Network:", args.network);
  console.log("Node:", nodeUrl);

  // Read the RIDE scripts
  const bridgeScript = fs.readFileSync(args.bridgeControllerPath, "utf-8");
  const tokenScript = fs.readFileSync(args.wsolTokenPath, "utf-8");

  console.log("\n--- Compiling bridge controller ---");
  console.log("Script size:", bridgeScript.length, "bytes");

  console.log("\n--- Compiling wSOL token contract ---");
  console.log("Script size:", tokenScript.length, "bytes");

  // Compilation and deployment require DCC SDK or direct REST:
  //
  // 1. Compile both RIDE scripts via node API
  // const compiledBridge = await compileRideScript(nodeUrl, bridgeScript);
  // const compiledToken  = await compileRideScript(nodeUrl, tokenScript);
  //
  // 2. Create SetScript transactions:
  //   - Bridge controller deployed to bridge account
  //   - wSOL token deployed to token issuer account
  //
  // 3. Sign with respective account private keys
  //
  // 4. Broadcast transactions
  //
  // 5. Issue wSOL token (Issue transaction with reissuable=true, decimals=9)

  console.log(
    "\n⚠️  Script is a template — integrate DCC SDK for actual deployment."
  );
  console.log("   Required steps:");
  console.log("   1. Compile RIDE scripts via DCC node /utils/script/compileCode");
  console.log("   2. Create SetScript transactions for both accounts");
  console.log("   3. Issue wSOL.DCC token (reissuable, 9 decimals)");
  console.log("   4. Set wSOL token account script");
  console.log("   5. Initialize bridge via InvokeScript: initialize()");
}

main().catch((err) => {
  console.error("❌ DCC deployment failed:", err);
  process.exit(1);
});
