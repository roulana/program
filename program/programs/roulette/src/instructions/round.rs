use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::derive::{commitment, derive_outcome, entropy_after, hex32, round_key, Entropy};
use crate::errors::RouletteError;
use crate::instructions::pay_from_vault;
use crate::rules;
use crate::state::*;

/// The dealer opens the next round (one at a time, not while paused).
#[derive(Accounts)]
pub struct OpenRound<'info> {
    #[account(mut)]
    pub dealer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump, has_one = dealer @ RouletteError::NotDealer)]
    pub table: Box<Account<'info, Table>>,
    #[account(init, payer = dealer, space = 8 + Round::INIT_SPACE,
        seeds = [ROUND_SEED, table.key().as_ref(), &(table.round_id + 1).to_le_bytes()], bump)]
    pub round: Box<Account<'info, Round>>,
    pub system_program: Program<'info, System>,
}

/// `commitment` is sha256 of the round's secret seed (the sealed envelope), public before any bet.
pub fn handle_open_round(ctx: Context<OpenRound>, commitment: [u8; 32]) -> Result<()> {
    let t = &mut ctx.accounts.table;
    require!(!t.paused, RouletteError::Paused);
    require!(!matches!(t.round_status, RoundStatus::Open | RoundStatus::Locked), RouletteError::RoundRunning);
    let now = Clock::get()?.unix_timestamp;
    // a pause between rounds, so the dealer cannot chain rounds back to back and leave investors no moment to withdraw
    require!(t.round_status == RoundStatus::None || now >= t.round_closed_at.saturating_add(ROUND_GAP_SECS), RouletteError::TooSoon);
    t.round_id += 1;
    t.round_status = RoundStatus::Open;
    let r = &mut ctx.accounts.round;
    r.table = t.key();
    r.id = t.round_id;
    r.status = RoundStatus::Open;
    r.opened_at = now;
    r.commitment = commitment;
    r.payer = ctx.accounts.dealer.key();
    r.bump = ctx.bumps.round;
    Ok(())
}

/// A player's whole bet set for the round, signed by their session key; the table (its dealer) pays the network fee.
/// Bets come only through the table: its seats and its share of the bank limit per player hold, and it pays out every
/// bet it lets in.
#[derive(Accounts)]
#[instruction(bets: Vec<Bet>)]
pub struct PlaceBets<'info> {
    #[account(mut, address = table.dealer @ RouletteError::NotDealer)]
    pub payer: Signer<'info>,
    pub session_key: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [ROUND_SEED, table.key().as_ref(), &round.id.to_le_bytes()], bump = round.bump,
        constraint = round.id == table.round_id @ RouletteError::NotCurrentRound)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [SESSION_SEED, table.key().as_ref(), session.wallet.as_ref()], bump = session.bump,
        constraint = session.key == session_key.key() @ RouletteError::WrongSessionKey)]
    pub session: Account<'info, Session>,
    #[account(mut, seeds = [SAFE_SEED, table.key().as_ref(), session.wallet.as_ref()], bump = safe.bump)]
    pub safe: Account<'info, Safe>,
    // room for the stacks placed only (a 65th is refused by the rules, and then nothing is made)
    #[account(init, payer = payer, space = RoundBets::space(bets.len()),
        seeds = [BETS_SEED, round.key().as_ref(), session.wallet.as_ref()], bump)]
    pub round_bets: Account<'info, RoundBets>,
    pub system_program: Program<'info, System>,
}

/// Records the bet set once, if the round is open and every limit holds: table limits, the session's cap and expiry,
/// the safe's balance, and the bank limit (the pool's worst-case loss in this round with these bets added). No bank (no
/// investor), no bets: what the pool won would belong to nobody, and the next investor would take it.
pub fn handle_place_bets(ctx: Context<PlaceBets>, bets: Vec<Bet>) -> Result<()> {
    require!(ctx.accounts.round.status == RoundStatus::Open, RouletteError::WrongRoundStatus);
    require!(ctx.accounts.table.total_shares > 0, RouletteError::PoolEmpty);
    require!(Clock::get()?.unix_timestamp < ctx.accounts.session.expires_at, RouletteError::SessionExpired);
    require!(ctx.accounts.safe.pending_round == 0, RouletteError::StakeInRound);
    let dollars = rules::check_bets(&bets)?;
    let t = &mut ctx.accounts.table;
    let stake = dollars.checked_mul(t.unit).ok_or(RouletteError::Overflow)?;
    let s = &mut ctx.accounts.session;
    require!(s.cap_remaining >= stake, RouletteError::SessionCap);
    let safe = &mut ctx.accounts.safe;
    require!(safe.balance >= stake, RouletteError::InsufficientSafe);
    let r = &mut ctx.accounts.round;
    let mut liab = r.liabilities;
    rules::add_liabilities(&mut liab, &bets, t.unit)?;
    let total = r.total_stake.checked_add(stake).ok_or(RouletteError::Overflow)?;
    let limit = (t.pool as u128 * t.bank_limit_bps as u128 / 10_000) as u64;
    require!(rules::worst_loss(&liab, total, rules::fee(total, t.fee_bps)) <= limit, RouletteError::BankLimit);
    r.liabilities = liab;
    r.total_stake = total;
    r.players += 1;
    s.cap_remaining -= stake;
    safe.balance -= stake;
    safe.pending_round = r.id;
    t.safes_total = t.safes_total.checked_sub(stake).ok_or(RouletteError::Overflow)?;
    t.escrow_total = t.escrow_total.checked_add(stake).ok_or(RouletteError::Overflow)?;
    let b = &mut ctx.accounts.round_bets;
    b.round = r.key();
    b.wallet = s.wallet;
    b.payer = ctx.accounts.payer.key();
    b.bets = bets;
    b.stake = stake;
    b.bump = ctx.bumps.round_bets;
    Ok(())
}

/// No more bets: the dealer locks the round. Its entropy will be the hash of a slot that does not exist yet.
#[derive(Accounts)]
pub struct LockRound<'info> {
    pub dealer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump, has_one = dealer @ RouletteError::NotDealer)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [ROUND_SEED, table.key().as_ref(), &round.id.to_le_bytes()], bump = round.bump,
        constraint = round.id == table.round_id @ RouletteError::NotCurrentRound)]
    pub round: Box<Account<'info, Round>>,
}

pub fn handle_lock_round(ctx: Context<LockRound>) -> Result<()> {
    require!(ctx.accounts.round.status == RoundStatus::Open, RouletteError::WrongRoundStatus);
    let clock = Clock::get()?;
    let r = &mut ctx.accounts.round;
    r.status = RoundStatus::Locked;
    r.locked_at = clock.unix_timestamp;
    r.lock_slot = clock.slot;
    ctx.accounts.table.round_status = RoundStatus::Locked;
    Ok(())
}

/// The dealer opens the envelope: the seed is checked against the commitment and mixed with the entropy slot's hash.
#[derive(Accounts)]
pub struct Reveal<'info> {
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [ROUND_SEED, table.key().as_ref(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: the SlotHashes sysvar, checked by address and read as raw bytes (too large to deserialize).
    #[account(address = SLOT_HASHES)]
    pub slot_hashes: UncheckedAccount<'info>,
    #[account(address = table.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump = table.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = table.owner)]
    pub owner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub const SLOT_HASHES: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");

/// Fixes the result: the number and the throw, the fee (the owner's half paid now, the buyback half set aside in the
/// vault), and what the pool owes the winners (set aside until each is settled). Anyone holding the seed may call it (in
/// practice only the dealer), within REVEAL_WINDOW_SECS of the lock; after that the round can only be cancelled.
pub fn handle_reveal(ctx: Context<Reveal>, seed: [u8; 32]) -> Result<()> {
    require!(ctx.accounts.round.status == RoundStatus::Locked, RouletteError::WrongRoundStatus);
    let deadline = ctx.accounts.round.locked_at.saturating_add(REVEAL_WINDOW_SECS);
    require!(Clock::get()?.unix_timestamp < deadline, RouletteError::RevealWindowPassed);
    require!(commitment(&seed) == ctx.accounts.round.commitment, RouletteError::WrongSeed);
    let target = ctx.accounts.round.lock_slot.saturating_add(ENTROPY_DELAY_SLOTS);
    let (entropy_slot, entropy_hash) = match entropy_after(&ctx.accounts.slot_hashes.try_borrow_data()?, target) {
        Entropy::Found(slot, hash) => (slot, hash),
        Entropy::NotYet => return err!(RouletteError::EntropyNotReady),
        Entropy::Gone => return err!(RouletteError::EntropyGone),
    };
    let t = &mut ctx.accounts.table;
    let r = &mut ctx.accounts.round;
    let o = derive_outcome(&round_key(&seed, &entropy_hash), r.id, t.throw_count);
    r.seed = seed;
    r.entropy_slot = entropy_slot;
    r.entropy_hash = entropy_hash;
    let fee = rules::fee(r.total_stake, t.fee_bps);
    let (to_owner, to_buyback) = rules::split_fee(fee);
    let owed = r.liabilities[o.number as usize];
    t.pool = t.pool.checked_add(r.total_stake).and_then(|p| p.checked_sub(fee)).and_then(|p| p.checked_sub(owed)).ok_or(RouletteError::Overflow)?;
    t.buyback_owed = t.buyback_owed.checked_add(to_buyback).ok_or(RouletteError::Overflow)?;
    finish(t, r, o.number, o.throw_index, fee, owed)?;
    // the receipt: the round's record is closed after payout and SlotHashes forgets the block within minutes, so the result
    // is also written into this transaction's log, which Solana keeps for good (anyone can check the round from it)
    msg!("receipt: round {} number {} throw {} block {} hash {}", r.id, o.number, o.throw_index, entropy_slot, hex32(&entropy_hash));
    let a = &ctx.accounts;
    pay_from_vault(&a.table, &a.vault, &a.owner_token, &a.mint, &a.token_program, to_owner)
}

/// The dealer did not reveal in time. Whoever holds the seed could by then know the result, so no number may be used
/// (holding back would let them choose). The round is cancelled like one never locked: every stake goes back by
/// `refund`, nobody wins or loses, no fee. Nothing is paid beyond the stakes, so stopping the dealer is worth nothing
/// to anyone. The table pauses, and may resume only EXIT_WINDOW_SECS later: a dealer who cancels the rounds it would
/// lose gets one such round per window, and every investor can leave in between. Anyone may call it.
#[derive(Accounts)]
pub struct Forfeit<'info> {
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [ROUND_SEED, table.key().as_ref(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
}

pub fn handle_forfeit(ctx: Context<Forfeit>) -> Result<()> {
    require!(ctx.accounts.round.status == RoundStatus::Locked, RouletteError::WrongRoundStatus);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.round.locked_at.saturating_add(REVEAL_WINDOW_SECS), RouletteError::TooEarlyToForfeit);
    let r = &mut ctx.accounts.round;
    r.status = RoundStatus::Voided;
    r.forfeited = true;
    r.number = NO_NUMBER;
    msg!("receipt: round {} forfeited", r.id);
    let t = &mut ctx.accounts.table;
    t.paused = true;
    t.resume_at = now.checked_add(EXIT_WINDOW_SECS).ok_or(RouletteError::Overflow)?;
    if t.round_id == r.id {
        t.round_status = RoundStatus::Voided;
        t.round_closed_at = now;
    }
    Ok(())
}

/// The round's result is fixed: the stakes leave escrow, the fee is counted, the players' payouts are set aside (the
/// caller has already moved the pool's side).
fn finish(t: &mut Table, r: &mut Round, number: u8, throw_index: u32, fee: u64, owed: u64) -> Result<()> {
    t.escrow_total = t.escrow_total.checked_sub(r.total_stake).ok_or(RouletteError::Overflow)?;
    t.owed_total = t.owed_total.checked_add(owed).ok_or(RouletteError::Overflow)?;
    t.fees_paid = t.fees_paid.checked_add(fee).ok_or(RouletteError::Overflow)?;
    t.total_staked = t.total_staked.checked_add(r.total_stake).ok_or(RouletteError::Overflow)?;
    if r.id == t.round_id {
        t.round_status = RoundStatus::Revealed;
        t.round_closed_at = Clock::get()?.unix_timestamp;
    }
    r.status = RoundStatus::Revealed;
    r.number = number;
    r.throw_index = throw_index;
    r.fee = fee;
    r.owed = owed;
    Ok(())
}

/// One player's bets of a revealed round are paid into their safe. Anyone may call it.
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [ROUND_SEED, table.key().as_ref(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [BETS_SEED, round.key().as_ref(), round_bets.wallet.as_ref()], bump = round_bets.bump)]
    pub round_bets: Account<'info, RoundBets>,
    #[account(mut, seeds = [SAFE_SEED, table.key().as_ref(), round_bets.wallet.as_ref()], bump = safe.bump)]
    pub safe: Account<'info, Safe>,
}

pub fn handle_settle(mut ctx: Context<Settle>) -> Result<()> {
    require!(ctx.accounts.round.status == RoundStatus::Revealed, RouletteError::WrongRoundStatus);
    require!(!ctx.accounts.round_bets.done, RouletteError::AlreadySettled);
    let pay = rules::payout(&ctx.accounts.round_bets.bets, ctx.accounts.round.number, ctx.accounts.table.unit);
    let a = &mut ctx.accounts;
    credit(&mut a.table, &mut a.round, &mut a.round_bets, &mut a.safe, pay, From::Owed)
}

/// A round the dealer opened but never locked is cancelled 10 minutes after opening. Anyone may call it. (A locked round
/// is never voided: it is revealed, or cancelled by a forfeit.)
#[derive(Accounts)]
pub struct VoidRound<'info> {
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [ROUND_SEED, table.key().as_ref(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
}

pub fn handle_void_round(ctx: Context<VoidRound>) -> Result<()> {
    require!(ctx.accounts.round.status == RoundStatus::Open, RouletteError::WrongRoundStatus);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.round.opened_at.saturating_add(VOID_AFTER_SECS), RouletteError::TooEarlyToVoid);
    let r = &mut ctx.accounts.round;
    r.status = RoundStatus::Voided;
    msg!("receipt: round {} voided", r.id);
    let t = &mut ctx.accounts.table;
    if t.round_id == r.id {
        t.round_status = RoundStatus::Voided;
        t.round_closed_at = now;
    }
    Ok(())
}

/// One player's stake of a cancelled round (voided, or forfeited) goes back into their safe. Anyone may call it.
#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [ROUND_SEED, table.key().as_ref(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [BETS_SEED, round.key().as_ref(), round_bets.wallet.as_ref()], bump = round_bets.bump)]
    pub round_bets: Account<'info, RoundBets>,
    #[account(mut, seeds = [SAFE_SEED, table.key().as_ref(), round_bets.wallet.as_ref()], bump = safe.bump)]
    pub safe: Account<'info, Safe>,
}

pub fn handle_refund(mut ctx: Context<Refund>) -> Result<()> {
    require!(ctx.accounts.round.status == RoundStatus::Voided, RouletteError::WrongRoundStatus);
    require!(!ctx.accounts.round_bets.done, RouletteError::AlreadySettled);
    let stake = ctx.accounts.round_bets.stake;
    let a = &mut ctx.accounts;
    credit(&mut a.table, &mut a.round, &mut a.round_bets, &mut a.safe, stake, From::Escrow)
}

/// Where a credit to a safe comes from: the payouts a revealed round set aside, or the stakes a voided round holds.
enum From { Owed, Escrow }

/// Moves `amount` into the player's safe and marks their bets done.
fn credit(t: &mut Table, r: &mut Round, b: &mut RoundBets, safe: &mut Safe, amount: u64, from: From) -> Result<()> {
    match from {
        From::Owed => {
            r.owed = r.owed.checked_sub(amount).ok_or(RouletteError::Overflow)?;
            t.owed_total = t.owed_total.checked_sub(amount).ok_or(RouletteError::Overflow)?;
        }
        From::Escrow => t.escrow_total = t.escrow_total.checked_sub(amount).ok_or(RouletteError::Overflow)?,
    }
    safe.balance = safe.balance.checked_add(amount).ok_or(RouletteError::Overflow)?;
    t.safes_total = t.safes_total.checked_add(amount).ok_or(RouletteError::Overflow)?;
    if safe.pending_round == r.id { safe.pending_round = 0; }
    b.payout = amount;
    b.done = true;
    r.settled += 1;
    Ok(())
}

/// A player's bets record, once settled or refunded, is closed; its rent goes back to whoever paid it. Anyone may call it.
#[derive(Accounts)]
pub struct CloseBets<'info> {
    #[account(mut, close = payer, seeds = [BETS_SEED, round_bets.round.as_ref(), round_bets.wallet.as_ref()], bump = round_bets.bump)]
    pub round_bets: Account<'info, RoundBets>,
    /// CHECK: receives the rent; must be the account that paid it.
    #[account(mut, address = round_bets.payer)]
    pub payer: UncheckedAccount<'info>,
}

pub fn handle_close_bets(ctx: Context<CloseBets>) -> Result<()> {
    require!(ctx.accounts.round_bets.done, RouletteError::NotAllSettled);
    Ok(())
}

/// A finished round (revealed or voided, every player settled or refunded) is closed; its rent goes back to whoever
/// paid it. Its history stays in the transactions. Anyone may call it.
#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, close = payer, seeds = [ROUND_SEED, table.key().as_ref(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: receives the rent; must be the account that paid it.
    #[account(mut, address = round.payer)]
    pub payer: UncheckedAccount<'info>,
}

pub fn handle_close_round(ctx: Context<CloseRound>) -> Result<()> {
    let r = &ctx.accounts.round;
    require!(matches!(r.status, RoundStatus::Revealed | RoundStatus::Voided) && r.settled == r.players, RouletteError::NotAllSettled);
    Ok(())
}
