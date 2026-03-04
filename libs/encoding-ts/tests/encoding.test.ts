/**
 * Test vector validation for the canonical encoding library.
 * Loads /spec/test-vectors.json and asserts all expected values.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  encodeDepositMessage,
  encodeUnlockMessage,
  hashMessage,
  parseDepositMessage,
  hexToBytes,
  bytesToHex,
  DEPOSIT_PREIMAGE_LENGTH,
  UNLOCK_PREIMAGE_LENGTH,
} from '../index';

const vectorsPath = path.resolve(__dirname, '../../..', 'spec/test-vectors.json');
const vectorData = JSON.parse(fs.readFileSync(vectorsPath, 'utf-8'));

describe('Canonical Encoding — Test Vectors', () => {
  for (const vec of vectorData.vectors) {
    const isUnlock = vec.type === 'unlock';

    it(`${vec.id}: ${vec.name}`, () => {
      if (isUnlock) {
        const preimage = encodeUnlockMessage({
          domainSep: vec.fields.domain_sep,
          transferId: hexToBytes(vec.fields.transfer_id),
          recipient: hexToBytes(vec.fields.recipient),
          amount: BigInt(vec.fields.amount),
          burnTxHash: hexToBytes(vec.fields.burn_tx_hash),
          dccChainId: vec.fields.dcc_chain_id,
          expiration: BigInt(vec.fields.expiration),
        });

        expect(preimage.length).toBe(vec.expected_preimage_length);
      } else {
        const preimage = encodeDepositMessage({
          domainSep: vec.fields.domain_sep,
          srcChainId: vec.fields.src_chain_id,
          dstChainId: vec.fields.dst_chain_id,
          srcProgramId: hexToBytes(vec.fields.src_program_id),
          slot: BigInt(vec.fields.slot),
          eventIndex: vec.fields.event_index,
          sender: hexToBytes(vec.fields.sender),
          recipient: hexToBytes(vec.fields.recipient),
          amount: BigInt(vec.fields.amount),
          nonce: BigInt(vec.fields.nonce),
          assetId: hexToBytes(vec.fields.asset_id),
        });

        expect(preimage.length).toBe(vec.expected_preimage_length);

        // If expected_message_id is provided, verify hash
        if (vec.expected_message_id) {
          const messageId = hashMessage(preimage);
          expect(bytesToHex(messageId)).toBe(vec.expected_message_id);
        }

        // Verify round-trip parsing
        if (vec.fields.domain_sep === 'DCC_SOL_BRIDGE_V1') {
          const parsed = parseDepositMessage(preimage);
          expect(parsed.srcChainId).toBe(vec.fields.src_chain_id);
          expect(parsed.dstChainId).toBe(vec.fields.dst_chain_id);
          expect(parsed.amount).toBe(BigInt(vec.fields.amount));
          expect(parsed.eventIndex).toBe(vec.fields.event_index);
        }
      }
    });
  }

  it('V-001 golden vector matches expected hash', () => {
    const vec = vectorData.vectors[0];
    const preimage = encodeDepositMessage({
      srcChainId: vec.fields.src_chain_id,
      dstChainId: vec.fields.dst_chain_id,
      srcProgramId: hexToBytes(vec.fields.src_program_id),
      slot: BigInt(vec.fields.slot),
      eventIndex: vec.fields.event_index,
      sender: hexToBytes(vec.fields.sender),
      recipient: hexToBytes(vec.fields.recipient),
      amount: BigInt(vec.fields.amount),
      nonce: BigInt(vec.fields.nonce),
      assetId: hexToBytes(vec.fields.asset_id),
    });

    expect(preimage.length).toBe(181);
    const messageId = hashMessage(preimage);
    expect(bytesToHex(messageId)).toBe('6ad0deb8ad960e168e2ceb0c6923a94b90c9015386ffd60ce8550d0e17d96444');
  });

  it('V-008 cross-chain collision test differs from V-001', () => {
    const v1 = vectorData.vectors[0];
    const v8 = vectorData.vectors[7];

    const h1 = bytesToHex(hashMessage(encodeDepositMessage({
      srcChainId: v1.fields.src_chain_id,
      dstChainId: v1.fields.dst_chain_id,
      srcProgramId: hexToBytes(v1.fields.src_program_id),
      slot: BigInt(v1.fields.slot),
      eventIndex: v1.fields.event_index,
      sender: hexToBytes(v1.fields.sender),
      recipient: hexToBytes(v1.fields.recipient),
      amount: BigInt(v1.fields.amount),
      nonce: BigInt(v1.fields.nonce),
      assetId: hexToBytes(v1.fields.asset_id),
    })));

    const h8 = bytesToHex(hashMessage(encodeDepositMessage({
      srcChainId: v8.fields.src_chain_id,
      dstChainId: v8.fields.dst_chain_id,
      srcProgramId: hexToBytes(v8.fields.src_program_id),
      slot: BigInt(v8.fields.slot),
      eventIndex: v8.fields.event_index,
      sender: hexToBytes(v8.fields.sender),
      recipient: hexToBytes(v8.fields.recipient),
      amount: BigInt(v8.fields.amount),
      nonce: BigInt(v8.fields.nonce),
      assetId: hexToBytes(v8.fields.asset_id),
    })));

    expect(h1).not.toBe(h8);
  });

  it('V-024/V-025 mutation tests differ from V-001', () => {
    const makeHash = (v: any) => bytesToHex(hashMessage(encodeDepositMessage({
      domainSep: v.fields.domain_sep,
      srcChainId: v.fields.src_chain_id,
      dstChainId: v.fields.dst_chain_id,
      srcProgramId: hexToBytes(v.fields.src_program_id),
      slot: BigInt(v.fields.slot),
      eventIndex: v.fields.event_index,
      sender: hexToBytes(v.fields.sender),
      recipient: hexToBytes(v.fields.recipient),
      amount: BigInt(v.fields.amount),
      nonce: BigInt(v.fields.nonce),
      assetId: hexToBytes(v.fields.asset_id),
    })));

    const h1 = makeHash(vectorData.vectors[0]);
    const h24 = makeHash(vectorData.vectors.find((v: any) => v.id === 'V-024'));
    const h25 = makeHash(vectorData.vectors.find((v: any) => v.id === 'V-025'));

    expect(h1).not.toBe(h24);
    expect(h1).not.toBe(h25);
  });
});
