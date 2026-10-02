import type { Address } from '@solana/kit';

export interface Deployment {
  programId: Address; mint: Address; table: Address; vault: Address; dealer: Address; owner: Address;
  /** The public buyback wallet and its USDC account (tables from v4 on). */
  buyback?: Address; buybackToken?: Address;
}
