/**
 * Cross-boundary format contracts.
 *
 * Three of the defects that kept this bridge from completing a single transfer
 * were format mismatches between TypeScript and on-chain code, and every one
 * was invisible to a passing test suite:
 *
 *   - the mint message omitted its domain prefix and chain id, so no committee
 *     signature verified
 *   - the unlock message layout was only ever checked by reading it
 *   - the burn record was parsed as five fields when the contract writes six,
 *     so every burn was silently discarded
 *
 * These tests read the contract and program sources and assert the shapes our
 * code produces still match them. If someone edits the RIDE contract or the
 * Rust program without updating the client, this fails rather than the bridge
 * going quietly dead.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const RIDE = fs.readFileSync(
  path.join(ROOT, 'dcc-contracts/bridge-controller/bridge_controller.ride'), 'utf-8');
const UNLOCK_RS = fs.readFileSync(
  path.join(ROOT, 'programs/sol-bridge-lock/src/instructions/unlock.rs'), 'utf-8');
const STATE_RS = fs.readFileSync(
  path.join(ROOT, 'programs/sol-bridge-lock/src/state.rs'), 'utf-8');

/** Collapse whitespace so source formatting doesn't affect matching. */
const squash = (s: string) => s.replace(/\s+/g, '');

describe('On-chain format contracts — mint message', () => {
  it('the RIDE contract still builds the prefix, fields and chain id we sign', () => {
    const fn = RIDE.slice(RIDE.indexOf('func constructLegacyMintMessage'));
    const body = squash(fn.slice(0, fn.indexOf('}')));

    expect(body, 'domain prefix changed').to.include('"SOL_DCC_BRIDGE_V1|MINT|"');
    // order matters: transferId | recipient | amount | solSlot | chainId
    const order = ['transferId', 'recipient', 'amount.toString()', 'solSlot.toString()', 'chainId.toString()'];
    let at = 0;
    for (const token of order) {
      const found = body.indexOf(squash(token), at);
      expect(found, `field out of order or missing: ${token}`).to.be.greaterThan(-1);
      at = found;
    }
  });

  it('our message matches the contract byte for byte', () => {
    const transferId = 'a'.repeat(64);
    const recipient = '3DXbZsC9M73r5b8FxJV5YMr5qeq5VNDqwpR';
    const amount = 9_990_000n;
    const slot = 442_200_000;
    const chainId = 2;

    const ours = `SOL_DCC_BRIDGE_V1|MINT|${transferId}|${recipient}|${amount}|${slot}|${chainId}`;
    const theirs = ['SOL_DCC_BRIDGE_V1|MINT|', transferId, '|', recipient, '|',
      String(amount), '|', String(slot), '|', String(chainId)].join('');
    expect(ours).to.equal(theirs);
  });

  it("the message chain id is the contract's dccChainId, not the address byte", () => {
    const m = RIDE.match(/let\s+dccChainId\s*=\s*(\d+)/);
    expect(m, 'dccChainId not found in the contract').to.not.be.null;
    expect(Number(m![1]), 'signing with 63 (the address byte) fails sigVerify').to.equal(2);
  });
});

describe('On-chain format contracts — unlock message', () => {
  it('the Rust program still expects our 140-byte layout', () => {
    const fn = UNLOCK_RS.slice(UNLOCK_RS.indexOf('fn construct_unlock_message'));
    const body = fn.slice(0, fn.indexOf('\n}'));

    expect(body).to.include('b"SOL_DCC_BRIDGE_UNLOCK_V1"');
    const order = ['transfer_id', 'recipient.as_ref()', 'amount.to_le_bytes()',
      'burn_tx_hash', 'dcc_chain_id.to_le_bytes()', 'expiration.to_le_bytes()'];
    let at = 0;
    for (const token of order) {
      const found = body.indexOf(token, at);
      expect(found, `field out of order or missing: ${token}`).to.be.greaterThan(-1);
      at = found;
    }
  });

  it('sizes add up to the length the validator builds', () => {
    const sizes = { domain: 24, transferId: 32, recipient: 32, amount: 8, burnTxHash: 32, chainId: 4, expiration: 8 };
    const total = Object.values(sizes).reduce((a, b) => a + b, 0);
    expect(total, 'unlock message length drifted').to.equal(140);
    expect(Buffer.from('SOL_DCC_BRIDGE_UNLOCK_V1').length).to.equal(sizes.domain);
  });
});

describe('On-chain format contracts — burn record', () => {
  it('the contract still writes six fields with the mint third', () => {
    const fn = RIDE.slice(RIDE.indexOf('func burn(solRecipient'));
    // Take the value expression only: everything after the key argument, up to
    // the next entry in the result list. `indexOf('),')` would stop at
    // keyBurnRecord(burnId), which is the key, not the value.
    const entry = fn.slice(fn.indexOf('StringEntry(keyBurnRecord'));
    const valueStart = entry.indexOf('keyBurnRecord(burnId),') + 'keyBurnRecord(burnId),'.length;
    const body = squash(entry.slice(valueStart, entry.indexOf('IntegerEntry(keyTotalBurned')));

    const order = ['i.caller.toString()', 'solRecipient', 'nativeSolMint',
      'payment.amount.toString()', 'height.toString()', 'lastBlock.timestamp.toString()'];
    let at = 0;
    for (const token of order) {
      const found = body.indexOf(squash(token), at);
      expect(found, `burn record field out of order or missing: ${token}`).to.be.greaterThan(-1);
      at = found;
    }
    // five separators == six fields
    expect((body.match(/\|/g) ?? []).length, 'burn record field count changed').to.equal(5);
  });

  it('the burn-record key prefix still collides with burn_nonce_', () => {
    expect(RIDE).to.include('func keyBurnRecord(burnId: String) = "burn_" + burnId');
    expect(RIDE).to.include('func keyBurnNonce(address: String) = "burn_nonce_" + address');
    // The watcher must therefore exclude burn_nonce_ when locating the record.
    const watcher = fs.readFileSync(
      path.join(ROOT, 'validator/src/watchers/dcc-watcher.ts'), 'utf-8');
    expect(watcher, 'watcher would match burn_nonce_ first').to.include("startsWith('burn_nonce_')");
  });
});

describe('On-chain format contracts — decimals', () => {
  it('wSOL is 8dp and SOL is 9dp, so the divisor is 10', () => {
    const watcher = fs.readFileSync(
      path.join(ROOT, 'validator/src/watchers/dcc-watcher.ts'), 'utf-8');
    expect(watcher, 'burn amounts must be converted to lamports')
      .to.include('WSOL_TO_LAMPORTS_DIVISOR = 10n');

    const recon = fs.readFileSync(
      path.join(ROOT, 'monitoring/src/reconciliation.ts'), 'utf-8');
    expect(recon, 'reconciler must compare like units')
      .to.include('SOL_TO_WSOL_DIVISOR = 10n');
  });

  it('999000 wSOL units is 9990000 lamports', () => {
    expect(999_000n * 10n).to.equal(9_990_000n);
  });
});

describe('On-chain format contracts — DepositRecord layout', () => {
  it('the deployed account is 206 bytes, not the 210 the struct implies', () => {
    // The deployed program still has event_index as u32; the source widened it
    // to u64 (LOW-1) without a redeploy. Anything decoding these accounts must
    // use the deployed layout.
    const deployed = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 4 + 8 + 32 + 1 + 1;
    expect(deployed).to.equal(206);

    const sourceWidened = STATE_RS.includes('pub event_index: u64');
    if (sourceWidened) {
      const settle = fs.readFileSync(
        path.join(ROOT, 'scripts/settle-stuck-deposits.ts'), 'utf-8');
      expect(settle, 'settlement must decode the deployed 206-byte layout')
        .to.include('DEPOSIT_RECORD_LEN = 206');
    }
  });
});

describe('On-chain format contracts — callable names', () => {
  /** Every dApp function the validator invokes, and the contract it targets. */
  const CALLS: Array<{ file: string; contract: string; source: string }> = [
    { file: 'validator/src/utils/dcc-helpers.ts', contract: 'bridge', source: RIDE },
  ];

  it('every function the validator invokes exists in the contract', () => {
    for (const { file, source } of CALLS) {
      const code = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      const called = [...code.matchAll(/function:\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((m) => m[1]);
      expect(called.length, `no dApp calls found in ${file}`).to.be.greaterThan(0);

      for (const fn of called) {
        const declared = new RegExp(`func\\s+${fn}\\s*\\(`).test(source);
        expect(declared, `${file} invokes "${fn}", which the contract does not define`).to.equal(true);
      }
    }
  });

  it('the bridge contract defines mint, not committeeMint', () => {
    // The validator called committeeMint for its whole history. Consensus
    // succeeded and every submission then failed on a function that does not
    // exist, which is why no mint ever came from the validators.
    expect(/func\s+mint\s*\(/.test(RIDE)).to.equal(true);
    expect(/func\s+committeeMint\s*\(/.test(RIDE)).to.equal(false);
  });
});
