#!/usr/bin/env python3
"""Debug proof encoding for DCC bn256Groth16Verify"""
import json, sys

d = json.load(open('/tmp/proof-data.json'))
p = d['proof']
signals = d['publicSignals']

P = 21888242871839275222246405745257275088696311157297823662689037894645226208583
R = 21888242871839275222246405745257275088548364400416034343698204186575808495617
HALF_P = P // 2

print('=== PROOF COORDINATES ===')
print(f'pi_a x: {p["pi_a"][0]}')
print(f'pi_a y: {p["pi_a"][1]}')
print(f'pi_a z: {p["pi_a"][2]}')
print()
print(f'pi_b x0: {p["pi_b"][0][0]}')
print(f'pi_b x1: {p["pi_b"][0][1]}')
print(f'pi_b y0: {p["pi_b"][1][0]}')
print(f'pi_b y1: {p["pi_b"][1][1]}')
print(f'pi_b z0: {p["pi_b"][2][0]}')
print(f'pi_b z1: {p["pi_b"][2][1]}')
print()
print(f'pi_c x: {p["pi_c"][0]}')
print(f'pi_c y: {p["pi_c"][1]}')
print(f'pi_c z: {p["pi_c"][2]}')

print('\n=== PUBLIC SIGNALS ===')
for i, s in enumerate(signals):
    print(f'  [{i}]: {s}')

# On-curve checks for G1: y^2 = x^3 + 3 (mod p)
print('\n=== ON-CURVE CHECKS ===')
for name, coords in [('pi_a', p['pi_a']), ('pi_c', p['pi_c'])]:
    x = int(coords[0]) % P
    y = int(coords[1]) % P
    lhs = pow(y, 2, P)
    rhs = (pow(x, 3, P) + 3) % P
    print(f'{name} on G1 curve: {lhs == rhs}')

# Flag checks
print('\n=== FLAG CHECKS ===')
y_a = int(p['pi_a'][1])
y_c = int(p['pi_c'][1])
y_b_c1 = int(p['pi_b'][1][0])  # c1 component of y for G2
print(f'pi_a y > P/2: {y_a > HALF_P} -> flag {"SET" if y_a > HALF_P else "unset"}')
print(f'pi_b y_c1 > P/2: {y_b_c1 > HALF_P} -> flag {"SET" if y_b_c1 > HALF_P else "unset"}')
print(f'pi_c y > P/2: {y_c > HALF_P} -> flag {"SET" if y_c > HALF_P else "unset"}')

# Range checks
print('\n=== RANGE CHECKS ===')
print(f'pi_a x < P: {int(p["pi_a"][0]) < P}')
print(f'pi_a y < P: {int(p["pi_a"][1]) < P}')
print(f'pi_b x0 < P: {int(p["pi_b"][0][0]) < P}')
print(f'pi_b x1 < P: {int(p["pi_b"][0][1]) < P}')
print(f'pi_b y0 < P: {int(p["pi_b"][1][0]) < P}')
print(f'pi_b y1 < P: {int(p["pi_b"][1][1]) < P}')
print(f'pi_c x < P: {int(p["pi_c"][0]) < P}')
print(f'pi_c y < P: {int(p["pi_c"][1]) < P}')
print(f'All signals < r: {all(int(s) < R for s in signals)}')
print(f'All signals < P: {all(int(s) < P for s in signals)}')

# Check x-coordinate encoding bytes
print('\n=== X-COORDINATE ENCODING ===')
def to_bytes(dec_str):
    n = int(dec_str)
    b = n.to_bytes(32, 'big')
    return b

# pi_a x
x_bytes = to_bytes(p['pi_a'][0])
print(f'pi_a x bytes[0]: 0x{x_bytes[0]:02x} (bits 7,6: {(x_bytes[0] >> 7) & 1},{(x_bytes[0] >> 6) & 1})')
# Check that bits 7 and 6 are 0 (x < P < 2^254, so top 2 bits of first byte should be 0)
print(f'pi_a x byte[0] < 0x40: {x_bytes[0] < 0x40} (MUST be true for flag space)')

x_bytes = to_bytes(p['pi_b'][0][0])  # c1 of x
print(f'pi_b x_c1 bytes[0]: 0x{x_bytes[0]:02x} (bits 7,6: {(x_bytes[0] >> 7) & 1},{(x_bytes[0] >> 6) & 1})')
print(f'pi_b x_c1 byte[0] < 0x40: {x_bytes[0] < 0x40}')

x_bytes = to_bytes(p['pi_c'][0])
print(f'pi_c x bytes[0]: 0x{x_bytes[0]:02x} (bits 7,6: {(x_bytes[0] >> 7) & 1},{(x_bytes[0] >> 6) & 1})')
print(f'pi_c x byte[0] < 0x40: {x_bytes[0] < 0x40}')

# Verify compressed bytes match what JS produces
print('\n=== COMPRESSED PROOF SIMULATION ===')
# G1 compress
def compress_g1(x_dec, y_dec):
    x = int(x_dec)
    y = int(y_dec)
    b = bytearray(x.to_bytes(32, 'big'))
    if y > HALF_P:
        b[0] |= 0x80
    return bytes(b)

# G2 compress  
def compress_g2(x_pair, y_pair):
    b = bytearray(64)
    c1_bytes = int(x_pair[0]).to_bytes(32, 'big')  # c1 (imaginary) first
    c0_bytes = int(x_pair[1]).to_bytes(32, 'big')  # c0 (real) second
    b[0:32] = c1_bytes
    b[32:64] = c0_bytes
    y_c1 = int(y_pair[0])
    if y_c1 > HALF_P:
        b[0] |= 0x80
    return bytes(b)

proof_a = compress_g1(p['pi_a'][0], p['pi_a'][1])
proof_b = compress_g2(p['pi_b'][0], p['pi_b'][1])
proof_c = compress_g1(p['pi_c'][0], p['pi_c'][1])

compressed = proof_a + proof_b + proof_c
print(f'Total compressed proof: {len(compressed)} bytes')
print(f'Proof hex: {compressed.hex()}')
print(f'Proof base64: {__import__("base64").b64encode(compressed).decode()}')

# Inputs
inputs_bytes = b''
for s in signals:
    inputs_bytes += int(s).to_bytes(32, 'big')
print(f'\nTotal inputs: {len(inputs_bytes)} bytes')
print(f'Inputs hex: {inputs_bytes.hex()}')
print(f'Inputs base64: {__import__("base64").b64encode(inputs_bytes).decode()}')

# G2 on-curve check for pi_b
# Twist curve: Y^2 = X^3 + b' where b' = 3/(9+i) = 3(9-i)/82 in Fq2
# Actually the BN128 twist is: Y^2 = X^3 + b/xi where xi = 9+i and b = 3
# So b' = 3/(9+i) = 3(9-i)/((9+i)(9-i)) = 3(9-i)/(81+1) = 3(9-i)/82
# = (27 - 3i)/82
# In Fq2: b' = (27/82, -3/82) mod P = (27 * inv(82), P - 3 * inv(82))
inv82 = pow(82, P - 2, P)
b_twist_c0 = (27 * inv82) % P  # real part
b_twist_c1 = (P - (3 * inv82) % P) % P  # imaginary part

# Fq2 multiplication: (a0 + a1*i)(b0 + b1*i) = (a0*b0 - a1*b1) + (a0*b1 + a1*b0)*i
def fq2_mul(a, b):
    a0, a1 = a
    b0, b1 = b
    c0 = (a0 * b0 - a1 * b1) % P
    c1 = (a0 * b1 + a1 * b0) % P
    return (c0, c1)

def fq2_add(a, b):
    return ((a[0] + b[0]) % P, (a[1] + b[1]) % P)

# x^3 + b_twist in Fq2
x_fq2 = (int(p['pi_b'][0][1]), int(p['pi_b'][0][0]))  # (c0=real, c1=imaginary)
y_fq2 = (int(p['pi_b'][1][1]), int(p['pi_b'][1][0]))  # (c0=real, c1=imaginary)

x2 = fq2_mul(x_fq2, x_fq2)
x3 = fq2_mul(x2, x_fq2)
rhs = fq2_add(x3, (b_twist_c0, b_twist_c1))
lhs = fq2_mul(y_fq2, y_fq2)

print(f'\n=== G2 ON-CURVE CHECK ===')
print(f'pi_b on G2 twist curve: {lhs == rhs}')
if lhs != rhs:
    print(f'  LHS (y^2): c0={lhs[0]}, c1={lhs[1]}')
    print(f'  RHS (x^3+b): c0={rhs[0]}, c1={rhs[1]}')
    # Try with swapped c0/c1 interpretation
    x_fq2_swap = (int(p['pi_b'][0][0]), int(p['pi_b'][0][1]))
    y_fq2_swap = (int(p['pi_b'][1][0]), int(p['pi_b'][1][1]))
    x2s = fq2_mul(x_fq2_swap, x_fq2_swap)
    x3s = fq2_mul(x2s, x_fq2_swap)
    rhss = fq2_add(x3s, (b_twist_c0, b_twist_c1))
    lhss = fq2_mul(y_fq2_swap, y_fq2_swap)
    print(f'  With SWAPPED c0/c1: on curve = {lhss == rhss}')
