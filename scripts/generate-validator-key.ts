#!/usr/bin/env ts-node

/**
 * generate-validator-key.ts
 *
 * Generates a validator signing key and prints the public key to register on
 * the DCC bridge contract's validator whitelist.
 *
 * The key is created through ThresholdSigner itself rather than by
 * re-implementing the crypto here — that guarantees the scheme (DecentralChain
 * Curve25519, matching the contract's sigVerify) and the on-disk format stay in
 * step with whatever the validator actually loads. An earlier version of this
 * script wrote a scrypt/JSON envelope of a NaCl Ed25519 key: wrong curve, and a
 * format the signer could not read.
 *
 * Usage:
 *   SIGNER_ENCRYPTION_KEY=<64-hex> \
 *     ts-node scripts/generate-validator-key.ts --output ./validator/data/keys/validator.key
 *
 * Without SIGNER_ENCRYPTION_KEY the signer writes the encryption key beside the
 * key file, which is fine for development and not for production.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ThresholdSigner } from '../validator/src/signer/threshold-signer';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Buffer): string {
  let num = BigInt('0x' + bytes.toString('hex'));
  const out: string[] = [];
  while (num > 0n) {
    out.unshift(BASE58[Number(num % 58n)]);
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out.unshift('1');
  }
  return out.join('') || '1';
}

async function main() {
  const argv = process.argv.slice(2);
  const at = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const outputPath = at('--output') ?? './validator.key';
  const force = argv.includes('--force');

  if (fs.existsSync(outputPath) && !force) {
    console.error(`Refusing to overwrite an existing key at ${outputPath}.`);
    console.error('Re-run with --force if you intend to rotate, and be aware the');
    console.error('new public key must be registered on the bridge contract before');
    console.error('this validator can take part in consensus again.');
    process.exit(1);
  }

  if (force && fs.existsSync(outputPath)) {
    const backup = `${outputPath}.${Date.now()}.bak`;
    fs.renameSync(outputPath, backup);
    if (fs.existsSync(`${outputPath}.key`)) {
      fs.renameSync(`${outputPath}.key`, `${backup}.key`);
    }
    console.log(`Existing key moved to ${backup}`);
  }

  const dir = path.dirname(outputPath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const signer = new ThresholdSigner({
    privateKeyPath: outputPath,
    hsmEnabled: false,
    hsmSlot: 0,
    hsmPin: '',
    keyRotationIntervalHours: 24 * 30,
  });
  await signer.initialize();

  const pub = signer.getPublicKey();

  console.log('\n=== Validator signing key ===');
  console.log('  scheme            : DecentralChain Curve25519 (contract sigVerify)');
  console.log('  key file          :', outputPath);
  console.log('  public key (hex)  :', pub.toString('hex'));
  console.log('  public key (b58)  :', base58(pub));
  console.log('\nRegister the base58 public key on the bridge contract before this');
  console.log('validator participates — attestations from an unregistered key are');
  console.log('rejected by the consensus whitelist.');

  if (!process.env.SIGNER_ENCRYPTION_KEY) {
    console.log('\nNote: SIGNER_ENCRYPTION_KEY was not set, so the encryption key was');
    console.log(`written to ${outputPath}.key. Set it in the environment for production.`);
  }
}

main().catch((err) => {
  console.error('Key generation failed:', err);
  process.exit(1);
});
