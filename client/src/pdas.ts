/** Addresses of the program's accounts (same seeds as solana/programs/roulette/src/state.rs). */
import { getAddressEncoder, getProgramDerivedAddress, getU64Encoder, type Address } from '@solana/kit';
import { ROULETTE_PROGRAM_ADDRESS } from './generated';

const addr = (a: Address) => getAddressEncoder().encode(a);
const text = (s: string) => new TextEncoder().encode(s);
const pda = async (...seeds: (Uint8Array | ReadonlyUint8Array)[]): Promise<Address> =>
  (await getProgramDerivedAddress({ programAddress: ROULETTE_PROGRAM_ADDRESS, seeds })).at(0) as Address;
type ReadonlyUint8Array = ReturnType<ReturnType<typeof getAddressEncoder>['encode']>;

export const tablePda = (mint: Address) => pda(text('table'), addr(mint));
export const vaultPda = (table: Address) => pda(text('vault'), addr(table));
export const safePda = (table: Address, wallet: Address) => pda(text('safe'), addr(table), addr(wallet));
export const sessionPda = (table: Address, wallet: Address) => pda(text('session'), addr(table), addr(wallet));
export const roundPda = (table: Address, id: bigint) => pda(text('round'), addr(table), getU64Encoder().encode(id));
export const betsPda = (round: Address, wallet: Address) => pda(text('bets'), addr(round), addr(wallet));
export const positionPda = (table: Address, investor: Address) => pda(text('position'), addr(table), addr(investor));

/** The upgradeable loader, which holds the program's code and its upgrade authority. */
export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;
/** The account naming the program's upgrade authority (init_table checks it: only that key sets up a table). */
export const programDataPda = async (): Promise<Address> =>
  (await getProgramDerivedAddress({ programAddress: UPGRADEABLE_LOADER, seeds: [addr(ROULETTE_PROGRAM_ADDRESS)] })).at(0) as Address;
