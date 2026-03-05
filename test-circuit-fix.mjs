import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const snarkjs = require('snarkjs');
const { keccak256 } = require('js-sha3');

const DOMAIN_SEP = 'DCC_SOL_BRIDGE_V1';

function writeU32LE(buf, val, off) { buf[off]=val&0xff; buf[off+1]=(val>>8)&0xff; buf[off+2]=(val>>16)&0xff; buf[off+3]=(val>>24)&0xff; }
function writeU64LE(buf, val, off) { let v=BigInt(val); for(let i=0;i<8;i++){buf[off+i]=Number(v&0xffn);v>>=8n;} }
function bytesToBitsLE(bytes){const bits=[];for(const b of bytes)for(let j=0;j<8;j++)bits.push(String((b>>j)&1));return bits;}
function numberToBitsLE(v,n){const bits=[];let bv=BigInt(v);for(let i=0;i<n;i++){bits.push((bv&1n).toString());bv>>=1n;}return bits;}
function hashToFieldElements(hash){let lo=0n;for(let i=15;i>=0;i--)lo=(lo<<8n)|BigInt(hash[i]);let hi=0n;for(let i=31;i>=16;i--)hi=(hi<<8n)|BigInt(hash[i]);return{lo,hi};}
function keccak256Hash(data){const h=keccak256(data);return new Uint8Array(h.match(/.{2}/g).map(b=>parseInt(b,16)));}

// Build a test preimage (181 bytes)
const preimage = new Uint8Array(181);
let off = 0;
const domainBytes = new TextEncoder().encode(DOMAIN_SEP);
preimage.set(domainBytes, off); off += 17;
writeU32LE(preimage, 1, off); off += 4;
writeU32LE(preimage, 2, off); off += 4;
const srcProgramId = new Uint8Array(32); srcProgramId[0]=0x80; srcProgramId[1]=0x61;
preimage.set(srcProgramId, off); off += 32;
writeU64LE(preimage, 12345n, off); off += 8;
writeU32LE(preimage, 0, off); off += 4;
const sender = new Uint8Array(32); sender[0]=0xAB;
preimage.set(sender, off); off += 32;
const recipient = new Uint8Array(32); recipient[0]=0xCD;
preimage.set(recipient, off); off += 32;
writeU64LE(preimage, 10000000n, off); off += 8;
writeU64LE(preimage, 1n, off); off += 8;
const assetId = new Uint8Array(32);
preimage.set(assetId, off); off += 32;

const hashBytes = keccak256Hash(preimage);
const msgIdFE = hashToFieldElements(hashBytes);
const recipFE = hashToFieldElements(recipient);

// Build single-leaf Merkle tree (depth 20)
const leaf = keccak256Hash(new Uint8Array([0, ...hashBytes]));
const ZERO = new Uint8Array(32);
const siblings = [];
let current = leaf;
for(let i=0;i<20;i++){
  siblings.push(ZERO);
  const nodePreimage = new Uint8Array(65);
  nodePreimage[0]=1;
  nodePreimage.set(current, 1);
  nodePreimage.set(ZERO, 33);
  current = keccak256Hash(nodePreimage);
}
const root = current;
const rootFE = hashToFieldElements(root);

const circuitInput = {
  checkpoint_root_lo: rootFE.lo.toString(),
  checkpoint_root_hi: rootFE.hi.toString(),
  message_id_lo: msgIdFE.lo.toString(),
  message_id_hi: msgIdFE.hi.toString(),
  amount: '10000000',
  recipient_lo: recipFE.lo.toString(),
  recipient_hi: recipFE.hi.toString(),
  version: '1',
  domain_sep: bytesToBitsLE(domainBytes),
  src_program_id: bytesToBitsLE(srcProgramId),
  slot_bits: numberToBitsLE(12345n, 64),
  event_index_bits: numberToBitsLE(0n, 32),
  sender: bytesToBitsLE(sender),
  nonce_bits: numberToBitsLE(1n, 64),
  asset_id: bytesToBitsLE(assetId),
  src_chain_id: numberToBitsLE(1n, 32),
  dst_chain_id: numberToBitsLE(2n, 32),
  siblings: siblings.map(s => bytesToBitsLE(s)),
  path_indices: new Array(20).fill(0),
};

console.log('Testing fixed circuit with Groth16 proof generation...');
console.log('Message ID:', Array.from(hashBytes).map(b=>b.toString(16).padStart(2,'0')).join(''));

const start = Date.now();
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  circuitInput,
  'zk/circuits/build/bridge_deposit_js/bridge_deposit.wasm',
  'zk/circuits/build/bridge_deposit_final.zkey',
);
console.log(`Proof generated in ${Date.now()-start}ms`);

const vkey = JSON.parse(readFileSync('zk/circuits/build/verification_key.json','utf8'));
const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
console.log(`Proof verification: ${valid ? 'VALID ✅' : 'INVALID ❌'}`);
console.log('Public signals:', publicSignals);

if (!valid) process.exit(1);
console.log('\n✅ Circuit fix verified — keccak256 and Groth16 working correctly!');
process.exit(0);
