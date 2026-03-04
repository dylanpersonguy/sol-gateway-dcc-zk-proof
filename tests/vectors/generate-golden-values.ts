/**
 * DCC <-> Solana ZK Bridge — Cross-Implementation Verification Test
 *
 * This test computes expected message_id and leaf values for all test vectors,
 * then stores them for comparison against the Rust implementation output.
 *
 * Run this first to generate golden values, then compare against Rust's output.
 *
 * Usage:
 *   npx tsx tests/vectors/generate-golden-values.ts
 */

import {
  computeMessageId,
  computeLeaf,
  hexToBytes,
  bytesToHex,
  MessageFields,
} from '../../zk/prover/src/message.js';
import { MESSAGE_ID_VECTORS } from './test-vectors.js';

interface GoldenValue {
  name: string;
  messageId: string;
  leaf: string;
  preimageLength: number;
}

function main() {
  console.log('='.repeat(72));
  console.log('  DCC <-> Solana ZK Bridge — Golden Value Generator');
  console.log('='.repeat(72));
  console.log();

  const goldenValues: GoldenValue[] = [];

  for (const v of MESSAGE_ID_VECTORS) {
    const fields: MessageFields = {
      srcChainId: v.input.srcChainId,
      dstChainId: v.input.dstChainId,
      srcProgramId: hexToBytes(v.input.srcProgramId),
      slot: BigInt(v.input.slot),
      eventIndex: v.input.eventIndex,
      sender: hexToBytes(v.input.sender),
      recipient: hexToBytes(v.input.recipient),
      amount: BigInt(v.input.amount),
      nonce: BigInt(v.input.nonce),
      assetId: hexToBytes(v.input.assetId),
    };

    const messageId = computeMessageId(fields);
    const leaf = computeLeaf(messageId);

    const golden: GoldenValue = {
      name: v.name,
      messageId: bytesToHex(messageId),
      leaf: bytesToHex(leaf),
      preimageLength: 181,
    };
    goldenValues.push(golden);

    console.log(`Vector: ${v.name}`);
    console.log(`  Description: ${v.description}`);
    console.log(`  message_id: ${golden.messageId}`);
    console.log(`  leaf:       ${golden.leaf}`);
    console.log();
  }

  // Output as Rust test constants for copy-paste
  console.log('='.repeat(72));
  console.log('  Rust test constants (paste into on-chain test):');
  console.log('='.repeat(72));
  console.log();

  for (const g of goldenValues) {
    const hexStr = g.messageId.slice(2); // remove 0x
    const bytes = [];
    for (let i = 0; i < hexStr.length; i += 2) {
      bytes.push(`0x${hexStr.substring(i, i + 2)}`);
    }
    console.log(`// ${g.name}`);
    console.log(
      `const EXPECTED_${g.name.toUpperCase()}: [u8; 32] = [${bytes.join(', ')}];`
    );
    console.log();
  }

  // Output as JSON for cross-platform verification
  console.log('='.repeat(72));
  console.log('  JSON output:');
  console.log('='.repeat(72));
  console.log(JSON.stringify(goldenValues, null, 2));
}

main();
