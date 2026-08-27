/**
 * snarkjs ships no type declarations, so `import * as snarkjs from 'snarkjs'`
 * fails under `noImplicitAny` and breaks the repo-wide `npm run typecheck`.
 * This ambient declaration restores the previous (untyped) behaviour.
 */
declare module 'snarkjs';
