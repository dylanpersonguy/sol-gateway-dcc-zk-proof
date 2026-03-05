/**
 * Test BN256 point compression roundtrip
 * Verifies that our encoding matches pairing_ce's format
 */
import fs from 'fs';

const BN256_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const HALF_P = BN256_P / 2n;

function fieldToBytes32BE(decStr) {
  let n = BigInt(decStr);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

function bytes32BEToField(bytes) {
  let n = 0n;
  for (let i = 0; i < 32; i++) {
    n = (n << 8n) | BigInt(bytes[i]);
  }
  return n;
}

function modpow(base, exp, mod) {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp = exp / 2n;
    base = (base * base) % mod;
  }
  return result;
}

// Tonelli-Shanks square root mod p
function sqrtModP(n) {
  if (n === 0n) return 0n;
  if (modpow(n, (BN256_P - 1n) / 2n, BN256_P) !== 1n) return null; // not a QR
  
  // BN256_P mod 4 = 3, so sqrt = n^((p+1)/4)
  return modpow(n, (BN256_P + 1n) / 4n, BN256_P);
}

// G1 compression test
function testG1Compression(name, ptArr) {
  const x = BigInt(ptArr[0]);
  const y = BigInt(ptArr[1]);
  
  const bytes = fieldToBytes32BE(ptArr[0]);
  const flag = y > HALF_P;
  if (flag) bytes[0] |= 0x80;
  
  // Decompress: clear flags, read x
  const decBytes = new Uint8Array(bytes);
  const hadFlag = (decBytes[0] & 0x80) !== 0;
  decBytes[0] &= 0x3f;
  const decX = bytes32BEToField(decBytes);
  
  // Verify x matches
  if (decX !== x) {
    console.log(`  ❌ ${name}: x mismatch!`);
    console.log(`    Original x: ${x}`);
    console.log(`    Decoded  x: ${decX}`);
    return false;
  }
  
  // Compute y from x: y² = x³ + 3
  const x3 = (((x * x) % BN256_P) * x) % BN256_P;
  const y2 = (x3 + 3n) % BN256_P;
  const sqrtY = sqrtModP(y2);
  if (sqrtY === null) {
    console.log(`  ❌ ${name}: x not on curve!`);
    return false;
  }
  const negSqrtY = (BN256_P - sqrtY) % BN256_P;
  
  // Choose y based on flag: pairing_ce uses "greatest" = (y > negy)
  const decompY = hadFlag ? (sqrtY > negSqrtY ? sqrtY : negSqrtY) : (sqrtY > negSqrtY ? negSqrtY : sqrtY);
  
  if (decompY !== y) {
    console.log(`  ❌ ${name}: y mismatch after decompression!`);
    console.log(`    Original y: ${y}`);
    console.log(`    Decomp   y: ${decompY}`);
    console.log(`    sqrt      : ${sqrtY}`);
    console.log(`    neg_sqrt  : ${negSqrtY}`);
    console.log(`    flag      : ${hadFlag}`);
    console.log(`    y > HALF_P: ${y > HALF_P}`);
    return false;
  }
  
  console.log(`  ✅ ${name}: G1 roundtrip OK (flag=${hadFlag})`);
  return true;
}

// G2 compression test  
function testG2Compression(name, ptArr) {
  // snarkjs: [[x0, x1], [y0, y1], "1"]  
  // x0 = c1 (imaginary), x1 = c0 (real)
  // y0 = c1 (imaginary), y1 = c0 (real)
  const x_c1 = BigInt(ptArr[0][0]); // imaginary
  const x_c0 = BigInt(ptArr[0][1]); // real
  const y_c1 = BigInt(ptArr[1][0]); // imaginary  
  const y_c0 = BigInt(ptArr[1][1]); // real
  
  // Compress: c1 first (32B), c0 second (32B)
  const bytes = new Uint8Array(64);
  bytes.set(fieldToBytes32BE(ptArr[0][0]), 0);  // x_c1
  bytes.set(fieldToBytes32BE(ptArr[0][1]), 32); // x_c0
  
  // Flag based on y Fq2 ordering (c1 first)
  const negy_c1 = (BN256_P - y_c1) % BN256_P;
  let flag;
  if (y_c1 !== negy_c1) {
    flag = y_c1 > negy_c1; // same as y_c1 > HALF_P since negy_c1 = p - y_c1
  } else {
    // y_c1 == 0, compare c0
    const negy_c0 = (BN256_P - y_c0) % BN256_P;
    flag = y_c0 > negy_c0;
  }
  if (flag) bytes[0] |= 0x80;
  
  // Decompress: read x components  
  const decBytes = new Uint8Array(bytes);
  const hadFlag = (decBytes[0] & 0x80) !== 0;
  decBytes[0] &= 0x3f;
  const dec_x_c1 = bytes32BEToField(decBytes.subarray(0, 32));
  const dec_x_c0 = bytes32BEToField(decBytes.subarray(32, 64));
  
  if (dec_x_c1 !== x_c1 || dec_x_c0 !== x_c0) {
    console.log(`  ❌ ${name}: x mismatch!`);
    return false;
  }
  
  console.log(`  ✅ ${name}: G2 x-coords OK, flag=${hadFlag} (y_c1=${y_c1 > HALF_P ? '>':'<='} HALF_P)`);
  return true;
}

// Read VK
const vkJson = JSON.parse(fs.readFileSync('zk/circuits/build/verification_key.json', 'utf8'));

console.log('=== VK Point Compression Roundtrip Test ===\n');
let allOk = true;

allOk &= testG1Compression('alpha_1', vkJson.vk_alpha_1);
allOk &= testG2Compression('beta_2', vkJson.vk_beta_2);
allOk &= testG2Compression('gamma_2', vkJson.vk_gamma_2);
allOk &= testG2Compression('delta_2', vkJson.vk_delta_2);

for (let i = 0; i < vkJson.IC.length; i++) {
  allOk &= testG1Compression(`IC[${i}]`, vkJson.IC[i]);
}

console.log(`\n=== VK Size Check ===`);
const vkSize = 32 + 64 + 64 + 64 + vkJson.IC.length * 32;
console.log(`Expected VK size: ${vkSize} bytes (IC count: ${vkJson.IC.length})`);
console.log(`For 8 inputs: should be ${256 + 32*8} = 512 bytes`);

// Check the uploaded VK on DCC
console.log('\n=== Verify On-Chain VK ===');
const r = await fetch('https://mainnet-node.decentralchain.io/addresses/data/3DYPrVWcN9BWbQpo3tfCR3fvrHDcGczZ9c6/groth16_vk');
const data = await r.json();
const onChainVK = Buffer.from(data.value.replace('base64:', ''), 'base64');
console.log(`On-chain VK size: ${onChainVK.length} bytes`);

// Recompute our VK and compare
const ourVK = new Uint8Array(512);
let offset = 0;

function compressG1VK(pt) {
  const bytes = fieldToBytes32BE(pt[0]);
  const y = BigInt(pt[1]);
  if (y > HALF_P) bytes[0] |= 0x80;
  return bytes;
}

function compressG2VK(pt) {
  const bytes = new Uint8Array(64);
  bytes.set(fieldToBytes32BE(pt[0][0]), 0);
  bytes.set(fieldToBytes32BE(pt[0][1]), 32);
  const y_c1 = BigInt(pt[1][0]);
  if (y_c1 > HALF_P) bytes[0] |= 0x80;
  return bytes;
}

ourVK.set(compressG1VK(vkJson.vk_alpha_1), offset); offset += 32;
ourVK.set(compressG2VK(vkJson.vk_beta_2), offset); offset += 64;
ourVK.set(compressG2VK(vkJson.vk_gamma_2), offset); offset += 64;
ourVK.set(compressG2VK(vkJson.vk_delta_2), offset); offset += 64;
for (let i = 0; i < vkJson.IC.length; i++) {
  ourVK.set(compressG1VK(vkJson.IC[i]), offset); offset += 32;
}

let matches = true;
for (let i = 0; i < 512; i++) {
  if (ourVK[i] !== onChainVK[i]) {
    console.log(`  Byte ${i} differs: ours=0x${ourVK[i].toString(16).padStart(2,'0')} onchain=0x${onChainVK[i].toString(16).padStart(2,'0')}`);
    matches = false;
  }
}
if (matches) {
  console.log('  ✅ Our VK matches on-chain VK byte-for-byte!');
} else {
  console.log('  ❌ VK mismatch detected!');
}

console.log(`\nOverall: ${allOk ? '✅ All tests passed' : '❌ Some tests failed'}`);
