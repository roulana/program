# Roulana: the Solana program

[Roulana](https://roulana.com) is a live European roulette table on Solana. Your money, every bet and the number of every round with bets are handled by a program on Solana, not by our server.

This repository holds that program, its tests, and two small tools to check the table yourself. The game, the 3D table
and the server are not here. The code is published to be read and checked: see Copyright at the end.

## On Solana (mainnet)

| | Address |
|---|---|
| The program | [`7FqVwLDtBPC1YsKpiXUw8HxCJP63hqQKGFcnYXgYgHBn`](https://explorer.solana.com/address/7FqVwLDtBPC1YsKpiXUw8HxCJP63hqQKGFcnYXgYgHBn) |
| The table (the program's books) | [`AfyXCSmsshBZ998TCCNbuUSB5hcw4RnJFeEk1LWhh63J`](https://explorer.solana.com/address/AfyXCSmsshBZ998TCCNbuUSB5hcw4RnJFeEk1LWhh63J) |
| The vault (every dollar on the table) | [`BPJmrTZFCBi4iK6bA4FxV43wM1qQqiHXBGMHbfd4aw56`](https://explorer.solana.com/address/BPJmrTZFCBi4iK6bA4FxV43wM1qQqiHXBGMHbfd4aw56) |
| USDC | [`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`](https://explorer.solana.com/address/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) |

## What the program does

**Your safe.** Your dollars sit in a safe on Solana that belongs to your wallet. Only your wallet can take them out, whether our server is up or not. Wins are paid into the safe by the program itself.

**One approval per session.** When you sit down, your wallet signs once: it lets a key in this browser place bets for you, up to a limit you choose and until a time you choose. That key can only place bets. It can never take money out, and you can end the session at any time.

**How a number is drawn.**

1. The round opens: the fingerprint (a SHA-256 hash) of a secret seed is sealed on Solana, before any bet.
2. Bets are placed and locked on Solana.
3. Betting closes, and the program waits for a Solana block made after the lock.
4. The seed is revealed, and the program checks it against the fingerprint.
5. The program mixes the seed with that block’s hash to get the number, and pays every bet itself.

Nobody can choose the number: the seed was fixed before the bets, and the block did not exist when they closed. Anyone can check any round with money on it on [roulana.com/verify](https://roulana.com/verify), or with `checks/verify-round.py` below. Rounds where nobody bets are only the wheel turning: nothing is at stake, so they are not sent to Solana.

**The spin you see.** The game shows a spin of the wheel with real physics, one of a set of spins whose hash the owner
names on Solana between rounds (`set_library`). After the number is drawn, the same randomness picks which spin of the
set is shown (the "throw"), and the game turns the wheel so that this spin ends on the number. The program writes both
in every round's receipt: `receipt: round <id> number <n> throw <t> block <slot> hash <block hash>`.

**If the dealer goes silent.** If a round is not revealed within 2 minutes of betting closing, it can only be cancelled, by anyone: every bet goes back to its safe, and nobody wins or loses. Every cancelled round is public on Solana, and the table then stops for 25 hours, longer than an investor’s notice, so it cannot happen quietly or often.

**The bank.** Investors own the bank in shares. Withdrawals take 24 hours’ notice and are paid only between rounds, and one round may risk at most a set share of the bank, between 0.5 % and 2 %.

**The fee.** The bank pays a fee of 1 % of the bets out of its house edge; players pay nothing extra. Half is the service fee, paid to the owner’s wallet for running Roulana: the servers, the Solana network fees for every bet and every round, upkeep and support. Half goes to the public buyback wallet: a split fixed in the program. A new buyback wallet takes effect only after 7 days of public notice.

**What the owner can do:**

- Pause the table (a round already running finishes)
- Set the bank limit per round, between 0.5 % and 2 %, between rounds
- Set the fee, never above 1 %
- Name a new dealer or a new owner, who can take over only after 25 hours in public
- Propose a new buyback wallet, which waits 7 days in public
- Name the set of wheel spins the game shows, between rounds

**What the owner cannot do:**

- Take money from anyone’s safe
- Change a bet or a payout
- Pick or change the number
- Change how the fee is split
- Make a new buyback wallet count without the 7 days’ notice
- Bring in a new dealer or owner without 25 hours’ public notice
- Resume the table sooner than 25 hours after a cancelled round

**Upgrades.** The program can still be upgraded with the owner’s key, kept offline. Every upgrade is public on Solana. Next: upgrades will need several keys and a 7-day wait, so everyone can leave
first; and a verified build, so anyone can prove that this code is the program running on Solana.

**The number, for developers.** The number: the key is the 32-byte seed followed by the 32-byte hash of the later block (64 bytes). The program computes HMAC-SHA256 of the text "roulette3:<round id>:<counter>" (the round’s id on Solana; counter 0, 1, 2 …), reads each result as 32-bit big-endian numbers and turns them into 0–36 by rejection sampling, so no number is favoured.

## Check it yourself

Nothing to install but Python 3.8 or newer. Both scripts ask Solana's public node, never Roulana's server
(`--rpc <url>` asks another node).

- **A round:** `python3 checks/verify-round.py <round address>`. The address is in every "Check" link on roulana.com.
  It checks the sealed fingerprint, the seed, the later block and the number, step by step.
- **The books:** `python3 checks/check-bank.py`. It reads the table and the vault at the same moment and adds up what
  the table owes: the players' safes, the bank, the bets of the round in play, wins not yet paid and the buyback half of
  the fee. Every one of those dollars must be in the vault.

## Run the program's tests

The tests play every money rule against the program itself, in [LiteSVM](https://github.com/LiteSVM/litesvm), a
Solana runtime on your own computer: deposits and withdrawals, sessions and their limits, bets, the draw, payouts, the
bank, the fee, cancelled rounds, the owner's delays, and attacks played through to the end.

```sh
cd client && bun install                  # Bun: https://bun.sh
bun scripts/fetch-program.ts              # the exact program running on Solana → program/target/deploy/roulette.so
bun test
```

Or test your own build of this code instead: `cd program && anchor build` (Anchor 0.32.1), then `bun test` in `client`.

## What is where

- `program/`: the Anchor program (Rust). `programs/roulette/src/spots.rs` lists the table's 157 bet spots; a test checks
  it against the game's own list.
- `idl/roulette.json`: the program's interface.
- `client/`: the TypeScript client (generated from the IDL with Codama), the test helpers and the tests.
- `checks/`: the round checker and the bank checker.

## Security

See [SECURITY.md](SECURITY.md): please report privately.

## Copyright

© 2026 Roulana. All rights reserved. This code is published so that anyone can read it, build it and test it, to check
the program on Solana. No licence is granted to copy, change or reuse it.
