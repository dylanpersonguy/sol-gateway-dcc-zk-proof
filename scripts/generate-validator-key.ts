#!/usr/bin/env ts-node

/**
 * generate-validator-key.ts
 *
 * Generates a new Ed25519 key pair for a validator node.
 * Stores encrypted with AES-256-GCM.
 *
 * Usage:
 *   ts-node scripts/generate-validator-key.ts \
 *     --output ./data/keys/validator.key \
 *     [--hsm-enabled true --hsm-slot 0]
 */

import * as nacl from "tweetnacl";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

async function main() {
  const argv = process.argv.slice(2);
  const outputIdx = argv.indexOf("--output");
  const outputPath = outputIdx !== -1 ? argv[outputIdx + 1] : "./validator.key";
  const hsmEnabled =
    argv.indexOf("--hsm-enabled") !== -1 &&
    argv[argv.indexOf("--hsm-enabled") + 1] === "true";

  console.log("=== Validator Key Generation ===");

  if (hsmEnabled) {
    console.log("HSM mode enabled — key will be generated inside HSM.");
    console.log(
      "TODO: Integrate PKCS#11 library for your specific HSM hardware."
    );
    console.log("Supported HSMs: YubiHSM2, AWS CloudHSM, Azure Managed HSM");
    return;
  }

  // Generate Ed25519 key pair
  const keypair = nacl.sign.keyPair();

  console.log("Public key (hex):", Buffer.from(keypair.publicKey).toString("hex"));
  console.log("Public key (base58):", encodeBase58(keypair.publicKey));

  // Prompt for encryption passphrase
  const passphrase = await prompt(
    "Enter passphrase to encrypt private key: "
  );
  if (!passphrase || passphrase.length < 12) {
    console.error("❌ Passphrase must be at least 12 characters.");
    process.exit(1);
  }

  // Derive encryption key from passphrase
  const salt = crypto.randomBytes(32);
  const encKey = crypto.scryptSync(passphrase, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(keypair.secretKey)),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Store encrypted key
  const keyData = {
    version: 1,
    algorithm: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    publicKey: Buffer.from(keypair.publicKey).toString("hex"),
    encryptedPrivateKey: encrypted.toString("hex"),
  };

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(keyData, null, 2), {
    mode: 0o600,
  });

  console.log(`\n✅ Key saved to ${outputPath}`);
  console.log("   File permissions: 600 (owner read/write only)");
  console.log("\n🔒 IMPORTANT: Back up this file and your passphrase separately!");
  console.log("   Never store both in the same location.");
}

function encodeBase58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  const result: string[] = [];
  while (num > 0n) {
    const mod = Number(num % 58n);
    result.unshift(ALPHABET[mod]);
    num = num / 58n;
  }
  for (const b of bytes) {
    if (b === 0) result.unshift("1");
    else break;
  }
  return result.join("");
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

main().catch((err) => {
  console.error("❌ Key generation failed:", err);
  process.exit(1);
});
