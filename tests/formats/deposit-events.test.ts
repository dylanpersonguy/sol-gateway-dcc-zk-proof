/**
 * The deposit decoder, against real mainnet events.
 *
 * The watcher reads Anchor event data at fixed byte offsets, and the SPL layout
 * inserts spl_mint before amount — so a native-layout read of an SPL deposit
 * would take part of the mint as the amount. The fixtures are the actual
 * "Program data:" logs from two mainnet deposits, so a change to the event
 * struct or the offsets fails here rather than silently misreading value.
 *
 * Regenerate with the capture in the commit that added this file if the program
 * is redeployed with a different event layout.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { SolanaWatcher } from '../../validator/src/watchers/solana-watcher';

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'deposit-events.fixture.json'), 'utf-8'));

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function decode(entry: any) {
  const w: any = new SolanaWatcher({
    rpcUrl: 'http://unused', programId: '9yJDb6VyjDHmQC7DLADDdLFm9wxWanXRM5x9SdZ3oVkF',
    requiredConfirmations: 32, reorgProtectionSlots: 50, pollIntervalMs: 5000,
  } as any);
  return w.parseDepositEvents({ logs: entry.logs, signature: entry.signature }, entry.slot);
}

describe('Deposit event decoding — real mainnet events', () => {
  it('decodes an SPL (USDC) deposit with the mint and amount intact', () => {
    const events = decode(FIXTURE.spl);
    expect(events, 'SPL deposit was not decoded at all').to.have.lengthOf(1);

    const e = events[0];
    // The amount sits after spl_mint in this layout. Reading it at the native
    // offset would yield the first 8 bytes of the mint instead.
    expect(e.tokenMint, 'spl_mint misread').to.equal(USDC);
    expect(e.amount, 'amount misread — check the SPL offset').to.equal(2_000_000n);
    expect(e.sender).to.equal('W5cxwawfenBEB5RLJnWNJHTtDwRzLjyWNFMZbnTTGNR');
    expect(e.slot).to.equal(FIXTURE.spl.slot);
  });

  it('decodes a native SOL deposit', () => {
    const events = decode(FIXTURE.native);
    expect(events, 'native deposit was not decoded at all').to.have.lengthOf(1);

    const e = events[0];
    expect(e.amount, 'amount should be positive lamports').to.be.a('bigint');
    expect(e.amount > 0n).to.equal(true);
    expect(e.slot).to.equal(FIXTURE.native.slot);
    // A native deposit carries no SPL mint; anything else means the SPL branch ran.
    expect(e.tokenMint ?? null, 'native deposit decoded as SPL').to.not.equal(USDC);
  });

  it('the recipient decodes to a valid DCC address', () => {
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (const key of ['spl', 'native'] as const) {
      const e = decode(FIXTURE[key])[0];
      const raw = Buffer.from(e.recipientDcc, 'hex');
      let last = raw.length - 1;
      while (last > 0 && raw[last] === 0) last--;
      let n = BigInt('0x' + raw.subarray(0, last + 1).toString('hex'));
      let b58 = '';
      while (n > 0n) { b58 = B58[Number(n % 58n)] + b58; n /= 58n; }

      expect(raw[0], `${key}: version byte`).to.equal(1);
      expect(raw[1], `${key}: DCC mainnet chain byte`).to.equal(63);
      expect(b58, `${key}: recipient is not a DCC address`).to.match(/^3D[1-9A-HJ-NP-Za-km-z]{33}$/);
    }
  });
});
