#!/usr/bin/env ts-node

/**
 * initialize-bridge.ts
 *
 * Bootstraps the Solana lock-program bridge configuration on any cluster.
 *
 * Usage:
 *   ts-node scripts/initialize-bridge.ts \
 *     --network devnet \
 *     --guardian <GUARDIAN_PUBKEY> \
 *     --min-validators 2 \
 *     --max-validators 5 \
 *     --min-deposit 1000000 \
 *     --max-deposit 10000000000 \
 *     --max-daily-outflow 50000000000 \
 *     --required-confirmations 32
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import * as fs from "fs";

/* ------------------------------------------------------------------ */

interface Args {
  network: string;
  guardian: string;
  minValidators: number;
  maxValidators: number;
  minDeposit: number;
  maxDeposit: number;
  maxDailyOutflow: number;
  requiredConfirmations: number;
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
    guardian: get("--guardian"),
    minValidators: parseInt(get("--min-validators"), 10),
    maxValidators: parseInt(get("--max-validators"), 10),
    minDeposit: parseInt(get("--min-deposit"), 10),
    maxDeposit: parseInt(get("--max-deposit"), 10),
    maxDailyOutflow: parseInt(get("--max-daily-outflow"), 10),
    requiredConfirmations: parseInt(get("--required-confirmations"), 10),
  };
}

async function main() {
  const args = parseArgs();

  console.log("=== SOL ⇄ DCC Bridge — Initialize ===");
  console.log("Network:", args.network);

  // Determine cluster URL
  const clusterUrls: Record<string, string> = {
    localnet: "http://127.0.0.1:8899",
    devnet: "https://api.devnet.solana.com",
    mainnet: "https://api.mainnet-beta.solana.com",
  };
  const rpcUrl = clusterUrls[args.network];
  if (!rpcUrl) throw new Error(`Unknown network: ${args.network}`);

  // Load wallet from default Solana keypair
  const walletPath =
    process.env.ANCHOR_WALLET ||
    `${process.env.HOME}/.config/solana/id.json`;
  const rawKey = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(rawKey));

  const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Load program from generated IDL
  const idl = JSON.parse(
    fs.readFileSync("target/idl/sol_bridge_lock.json", "utf-8")
  );
  const programId = new PublicKey(idl.address);
  const program = new anchor.Program(idl, provider);

  const guardian = new PublicKey(args.guardian);

  console.log("Authority:", keypair.publicKey.toBase58());
  console.log("Guardian:", guardian.toBase58());
  console.log("Min validators:", args.minValidators);
  console.log("Max validators:", args.maxValidators);
  console.log("Min deposit:", args.minDeposit, "lamports");
  console.log("Max deposit:", args.maxDeposit, "lamports");
  console.log("Max daily outflow:", args.maxDailyOutflow, "lamports");
  console.log("Required confirmations:", args.requiredConfirmations);

  const [bridgeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_config")],
    programId
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    programId
  );

  const tx = await (program.methods as any)
    .initialize({
      guardian,
      minValidators: args.minValidators,
      maxValidators: args.maxValidators,
      minDeposit: new anchor.BN(args.minDeposit),
      maxDeposit: new anchor.BN(args.maxDeposit),
      maxDailyOutflow: new anchor.BN(args.maxDailyOutflow),
      maxUnlockAmount: new anchor.BN(args.maxDeposit), // default to max deposit
      requiredConfirmations: args.requiredConfirmations,
      largeWithdrawalDelay: new anchor.BN(3600),
      largeWithdrawalThreshold: new anchor.BN(args.maxDeposit),
      dccChainId: 87,
      solanaChainId: 1,
    })
    .accountsPartial({
      authority: keypair.publicKey,
      bridgeConfig,
      vault,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("✅ Bridge initialized! TX:", tx);
  console.log("   Bridge Config PDA:", bridgeConfig.toBase58());
  console.log("   Vault PDA:", vault.toBase58());
}

main().catch((err) => {
  console.error("❌ Initialization failed:", err);
  process.exit(1);
});
