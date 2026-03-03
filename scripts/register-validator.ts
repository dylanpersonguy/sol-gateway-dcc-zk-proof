#!/usr/bin/env ts-node

/**
 * register-validator.ts
 *
 * Registers a validator on the Solana bridge program.
 *
 * Usage:
 *   ts-node scripts/register-validator.ts \
 *     --network devnet \
 *     --validator-pubkey <BASE58_PUBKEY>
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";

async function main() {
  const argv = process.argv.slice(2);
  const network = argv[argv.indexOf("--network") + 1];
  const validatorPubkey = new PublicKey(
    argv[argv.indexOf("--validator-pubkey") + 1]
  );

  console.log("=== Register Validator ===");
  console.log("Network:", network);
  console.log("Validator:", validatorPubkey.toBase58());

  const clusterUrls: Record<string, string> = {
    localnet: "http://127.0.0.1:8899",
    devnet: "https://api.devnet.solana.com",
    mainnet: "https://api.mainnet-beta.solana.com",
  };
  const rpcUrl = clusterUrls[network];
  if (!rpcUrl) throw new Error(`Unknown network: ${network}`);

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

  const [bridgeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_config")],
    programId
  );
  const [validatorEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("validator"), validatorPubkey.toBuffer()],
    programId
  );

  const tx = await (program.methods as any)
    .registerValidator({ validatorPubkey })
    .accountsPartial({
      authority: keypair.publicKey,
      bridgeConfig,
      validatorEntry,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("✅ Validator registered! TX:", tx);
}

main().catch((err) => {
  console.error("❌ Registration failed:", err);
  process.exit(1);
});
