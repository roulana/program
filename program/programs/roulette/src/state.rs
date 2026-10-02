use anchor_lang::prelude::*;

/// One bet as recorded on-chain: a spot (index into spots::SPOTS) and whole dollars.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct Bet {
    pub spot: u8,
    pub dollars: u32,
}

pub const MAX_BETS: usize = 64;
pub const MAX_ROUND_DOLLARS: u64 = 10_000;

pub const TABLE_SEED: &[u8] = b"table";
pub const VAULT_SEED: &[u8] = b"vault";
pub const SAFE_SEED: &[u8] = b"safe";
pub const SESSION_SEED: &[u8] = b"session";
pub const ROUND_SEED: &[u8] = b"round";
pub const BETS_SEED: &[u8] = b"bets";
pub const POSITION_SEED: &[u8] = b"position";

pub const FEE_CAP_BPS: u16 = 100;
pub const BANK_LIMIT_MIN_BPS: u16 = 50;
pub const BANK_LIMIT_CAP_BPS: u16 = 200;
/// An investor's withdrawal notice.
pub const NOTICE_SECS: i64 = 24 * 60 * 60;
/// What could turn the table against investors waits longer than their notice, so each of them can leave first: a new
/// dealer or owner takes over this long after the owner names it, and the table resumes this long after a cancelled round.
pub const EXIT_WINDOW_SECS: i64 = NOTICE_SECS + 60 * 60;
pub const VOID_AFTER_SECS: i64 = 10 * 60;
pub const MAX_SESSION_SECS: i64 = 7 * 24 * 60 * 60;
/// Seconds between a round's end (reveal or void) and the next round, so investors' withdrawals always have a window.
pub const ROUND_GAP_SECS: i64 = 5;
/// The entropy slot is the first slot at least this many slots after the lock (it does not exist when bets close).
pub const ENTROPY_DELAY_SLOTS: u64 = 2;
/// A locked round must be revealed within this time (well inside SlotHashes' ~512 slots); after it, it can only be
/// cancelled (forfeit), by anyone. Never both: whoever sees a late reveal cannot choose between them.
pub const REVEAL_WINDOW_SECS: i64 = 120;
/// A cancelled (forfeited) round has no number.
pub const NO_NUMBER: u8 = u8::MAX;
/// The least one investment may be, in dollars.
pub const MIN_INVEST_DOLLARS: u64 = 100;
/// How long a proposed new buyback account waits before anyone may apply it: long enough for everyone to see it.
pub const BUYBACK_NOTICE_SECS: i64 = 7 * 24 * 60 * 60;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RoundStatus { None, Open, Locked, Revealed, Voided }

#[account]
#[derive(InitSpace)]
pub struct Table {
    pub owner: Pubkey,
    pub dealer: Pubkey,
    pub mint: Pubkey,
    /// Base units per dollar (10^decimals).
    pub unit: u64,
    pub fee_bps: u16,
    pub bank_limit_bps: u16,
    pub library_hash: [u8; 32],
    pub throw_count: u32,
    pub paused: bool,
    /// Id of the latest round (0: none yet) and its status.
    pub round_id: u64,
    pub round_status: RoundStatus,
    /// Ledger inside the vault: vault balance = safes_total + pool + escrow_total + owed_total + buyback_owed.
    pub pool: u64,
    pub total_shares: u64,
    pub safes_total: u64,
    pub escrow_total: u64,
    pub owed_total: u64,
    pub fees_paid: u64,
    pub total_staked: u64,
    /// When the latest round was revealed or voided (the next may open ROUND_GAP_SECS later).
    pub round_closed_at: i64,
    /// The public buyback wallet's token account. Half of every fee is set aside for it (rules::split_fee, a constant)
    /// and anyone may send what is set aside (pay_buyback). No round depends on this account.
    pub buyback_token: Pubkey,
    /// Set aside in the vault for the buyback account, not sent yet.
    pub buyback_owed: u64,
    /// Sent to the buyback account so far.
    pub buyback_paid: u64,
    /// A new buyback account the owner proposed (Pubkey::default(): none), and from when anyone may apply it.
    pub pending_buyback_token: Pubkey,
    pub buyback_change_at: i64,
    /// After a cancelled round the table may not resume before this time (0: no wait).
    pub resume_at: i64,
    /// A new owner the owner named (Pubkey::default(): none), and from when it may accept with its own key.
    pub pending_owner: Pubkey,
    pub owner_change_at: i64,
    /// A new dealer the owner named (Pubkey::default(): none), and from when anyone may apply it.
    pub pending_dealer: Pubkey,
    pub dealer_change_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
    /// Room for settings a later version adds (taken from here, so the table keeps its size and its address).
    pub reserved: [u8; 256],
}

#[account]
#[derive(InitSpace)]
pub struct Safe {
    pub wallet: Pubkey,
    pub balance: u64,
    /// Round whose bets are not settled or refunded yet (0: none).
    pub pending_round: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub table: Pubkey,
    pub investor: Pubkey,
    /// All shares, including those waiting to be withdrawn (they keep sharing wins and losses until paid).
    pub shares: u64,
    pub pending_shares: u64,
    pub unlock_at: i64,
    /// Plain counters for the Bank page (money is never computed from them): all put in, all taken out, first joined.
    pub invested: u64,
    pub withdrawn: u64,
    pub joined_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Session {
    pub wallet: Pubkey,
    /// The browser's key that may place bets for `wallet` (and do nothing else).
    pub key: Pubkey,
    pub cap_remaining: u64,
    pub expires_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub table: Pubkey,
    pub id: u64,
    pub status: RoundStatus,
    pub opened_at: i64,
    pub locked_at: i64,
    /// What the pool pays (stakes back + winnings) if number n wins.
    pub liabilities: [u64; 37],
    pub total_stake: u64,
    pub players: u32,
    pub settled: u32,
    /// The sealed envelope: sha256 of the dealer's secret seed, published when the round opened.
    pub commitment: [u8; 32],
    pub lock_slot: u64,
    /// Revealed: the seed, and the slot and hash it was mixed with.
    pub seed: [u8; 32],
    pub entropy_slot: u64,
    pub entropy_hash: [u8; 32],
    /// The dealer did not reveal in time: the round was cancelled (status Voided, number NO_NUMBER); every stake goes
    /// back by refund and the table paused.
    pub forfeited: bool,
    pub number: u8,
    pub throw_index: u32,
    pub fee: u64,
    /// Still to be credited to winners' safes.
    pub owed: u64,
    /// Who paid the account's rent (gets it back when the round is closed).
    pub payer: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RoundBets {
    pub round: Pubkey,
    pub wallet: Pubkey,
    pub payer: Pubkey,
    #[max_len(64)]
    pub bets: Vec<Bet>,
    pub stake: u64,
    pub payout: u64,
    /// Settled or refunded.
    pub done: bool,
    pub bump: u8,
}

impl RoundBets {
    /// The room a record of `bets` stacks takes (the discriminator, three addresses, the stacks, two amounts, done,
    /// bump): only what it holds, so the deposit it ties up is as small as it can be (it comes back when it closes).
    pub const fn space(bets: usize) -> usize {
        8 + 32 * 3 + 4 + 5 * bets + 8 * 2 + 1 + 1
    }
}

#[cfg(test)]
mod space_tests {
    use super::*;

    #[test]
    fn a_bets_record_reserves_room_for_its_bets_only() {
        assert_eq!(RoundBets::space(64), 8 + RoundBets::INIT_SPACE); // the most is what it always was
        assert_eq!(RoundBets::space(3), 141);
        assert_eq!(RoundBets::space(1), 131);
    }
}
