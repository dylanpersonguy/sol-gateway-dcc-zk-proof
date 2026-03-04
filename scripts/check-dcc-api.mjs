import * as dcc from '@decentralchain/decentralchain-transactions';
import dotenv from 'dotenv';

dotenv.config();

const required = (key) => {
	const value = process.env[key];
	if (!value) throw new Error(`Missing required env var: ${key}`);
	return value;
};

const keys = Object.keys(dcc);
console.log('Exports:', keys.join(', '));
const seed = required('DCC_VALIDATOR_SEED');
const chainId = '?'; // DCC mainnet
// Derive two addresses:
const addr1 = dcc.libs.crypto.address(seed, chainId);
const addr2 = dcc.libs.crypto.address({seed, nonce: 1}, chainId);
const pk1 = dcc.libs.crypto.publicKey(seed);
const pk2 = dcc.libs.crypto.publicKey({seed, nonce: 1});
console.log('Account 0 (bridge_controller):', addr1, 'pk:', pk1);
console.log('Account 1 (wsol_token):', addr2, 'pk:', pk2);
