// ═══════════════════════════════════════════════════════════════
// DCC IDENTIFIER DECODING
// ═══════════════════════════════════════════════════════════════

/**
 * DecentralChain ids — burn ids, transaction ids — are base58 of 32 bytes.
 * Parsing them as hex yields an empty buffer, which silently becomes 32 zero
 * bytes in a signed message: the unlock then commits to no transfer id and no
 * burn transaction at all, and the signature cannot match what the Solana
 * program recomputes from the parameters it is given.
 */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode a base58 DCC identifier into exactly 32 bytes. */
export function dccIdToBytes32(id: string): Buffer {
  const out = Buffer.alloc(32);
  if (!id) return out;

  let n = 0n;
  for (const c of id) {
    const i = B58.indexOf(c);
    if (i < 0) return out; // not base58 — leave zeroed rather than guess
    n = n * 58n + BigInt(i);
  }

  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = Buffer.from(hex, 'hex');

  let leadingZeros = 0;
  for (const c of id) {
    if (c !== '1') break;
    leadingZeros++;
  }

  const full = Buffer.concat([Buffer.alloc(leadingZeros), body]);
  full.copy(out, Math.max(0, 32 - full.length), Math.max(0, full.length - 32));
  return out;
}

/**
 * Expiration for an unlock, in seconds.
 *
 * Derived from the burn's own on-chain timestamp so every validator computes
 * the same value. Taking it from local time made each node sign a different
 * message, and consensus could never agree on one.
 *
 * The window has to outlast any plausible outage. At one hour, a burn that went
 * unprocessed while validators were down could never be unlocked afterwards —
 * the program rejects it with TransferExpired and the SOL stays in the vault
 * with no automatic path out. A day gives recovery room while still bounding
 * how stale a signed unlock may be; the unlock record PDA is what actually
 * prevents replay.
 */
export function unlockExpiration(
  burnTimestampMs: number,
  windowSeconds = parseInt(process.env.UNLOCK_EXPIRY_SECONDS || '86400', 10),
): number {
  return Math.floor(burnTimestampMs / 1000) + windowSeconds;
}
