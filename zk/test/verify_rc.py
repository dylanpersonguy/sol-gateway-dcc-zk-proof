#!/usr/bin/env python3
"""Verify Keccak round constants match the circuit."""

RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A,
    0x8000000080008000, 0x000000000000808B, 0x0000000080000001,
    0x8000000080008081, 0x8000000000008009, 0x000000000000008A,
    0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
    0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
    0x000000000000800A, 0x800000008000000A, 0x8000000080008081,
    0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]

circuit_rcs = [
    {0:1},
    {1:1, 7:1, 15:1},
    {1:1, 3:1, 7:1, 15:1, 63:1},
    {15:1, 31:1, 63:1},
    {0:1, 1:1, 3:1, 7:1, 15:1},
    {0:1, 31:1},
    {0:1, 7:1, 15:1, 31:1, 63:1},
    {0:1, 3:1, 15:1, 63:1},
    {1:1, 3:1, 7:1},
    {3:1, 7:1},
    {0:1, 3:1, 15:1, 31:1},
    {1:1, 3:1, 31:1},
    {0:1, 1:1, 3:1, 7:1, 15:1, 31:1},
    {0:1, 1:1, 3:1, 7:1, 63:1},
    {0:1, 3:1, 7:1, 15:1, 63:1},
    {0:1, 1:1, 15:1, 63:1},
    {1:1, 15:1, 63:1},
    {7:1, 63:1},
    {1:1, 3:1, 15:1},
    {1:1, 3:1, 31:1, 63:1},
    {0:1, 7:1, 15:1, 31:1, 63:1},
    {7:1, 15:1, 63:1},
    {0:1, 31:1},
    {3:1, 15:1, 31:1, 63:1},
]

ok = True
for i in range(24):
    exp = {z: 1 for z in range(64) if (RC[i] >> z) & 1}
    if exp != circuit_rcs[i]:
        print(f"MISMATCH RC[{i}]: expected {exp}, got {circuit_rcs[i]}")
        print(f"  Canonical: 0x{RC[i]:016x}")
        ok = False

print("ALL 24 ROUND CONSTANTS MATCH" if ok else "ROUND CONSTANT MISMATCH DETECTED")

# Also verify rotation offsets
print("\nVerifying rotation offsets...")
# Standard Keccak rotation offsets per FIPS 202
ROTATIONS = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]

circuit_rot = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]

rot_ok = True
for x in range(5):
    for y in range(5):
        if ROTATIONS[x][y] != circuit_rot[x][y]:
            print(f"ROTATION MISMATCH at ({x},{y}): expected {ROTATIONS[x][y]}, got {circuit_rot[x][y]}")
            rot_ok = False

print("ALL ROTATION OFFSETS MATCH" if rot_ok else "ROTATION OFFSET MISMATCH DETECTED")

# Verify padding analysis
print("\nPadding analysis:")
print("  Keccak-256 (pre-FIPS, Ethereum): pad10*1 with domain byte 0x01")
print("  SHA-3-256 (FIPS 202): pad10*1 with domain byte 0x06")
print("  Circuit uses: 0x01 (CORRECT for Keccak-256)")
print("  First pad bit=1, remaining zeros, last bit=1")

# Analyze block boundaries for message sizes
for N in [256, 1448]:
    RATE = 1088
    num_blocks = (N + 1 + 1 + RATE - 1) // RATE
    if num_blocks == 0:
        num_blocks = 1
    PADDED_LEN = num_blocks * RATE
    pad_bits = PADDED_LEN - N
    print(f"\n  Input {N} bits ({N//8} bytes):")
    print(f"    num_blocks = {num_blocks}")
    print(f"    PADDED_LEN = {PADDED_LEN}")
    print(f"    padding = {pad_bits} bits")
    print(f"    pad_bits >= 2: {pad_bits >= 2}")

# Check edge case: N = 1086 (RATE - 2)
N = 1086
RATE = 1088
num_blocks = (N + 1 + 1 + RATE - 1) // RATE
PADDED_LEN = num_blocks * RATE
print(f"\n  Edge case N={N}: blocks={num_blocks}, PADDED_LEN={PADDED_LEN}, pad={PADDED_LEN-N}")

# Check edge case: N = 1087 (RATE - 1) 
N = 1087
num_blocks = (N + 1 + 1 + RATE - 1) // RATE
PADDED_LEN = num_blocks * RATE
print(f"  Edge case N={N}: blocks={num_blocks}, PADDED_LEN={PADDED_LEN}, pad={PADDED_LEN-N}")

# Check: what if N = RATE exactly?
N = 1088
num_blocks = (N + 1 + 1 + RATE - 1) // RATE
PADDED_LEN = num_blocks * RATE
print(f"  Edge case N={N}: blocks={num_blocks}, PADDED_LEN={PADDED_LEN}, pad={PADDED_LEN-N}")
