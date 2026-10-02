use anchor_lang::prelude::*;
use crate::errors::RouletteError;
use crate::state::*;

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump, has_one = owner @ RouletteError::NotOwner)]
    pub table: Box<Account<'info, Table>>,
}

fn between_rounds(t: &Table) -> bool { !matches!(t.round_status, RoundStatus::Open | RoundStatus::Locked) }

/// Only between rounds: a round's fee is the one in force when its bets were placed and checked against the bank limit.
pub fn handle_set_fee(ctx: Context<OwnerOnly>, bps: u16) -> Result<()> {
    require!(bps <= FEE_CAP_BPS, RouletteError::FeeAboveCap);
    require!(between_rounds(&ctx.accounts.table), RouletteError::RoundRunning);
    ctx.accounts.table.fee_bps = bps;
    Ok(())
}

/// Only between rounds: a round's limit is the one in force when it opened.
pub fn handle_set_bank_limit(ctx: Context<OwnerOnly>, bps: u16) -> Result<()> {
    require!((BANK_LIMIT_MIN_BPS..=BANK_LIMIT_CAP_BPS).contains(&bps), RouletteError::BankLimitOutOfRange);
    require!(between_rounds(&ctx.accounts.table), RouletteError::RoundRunning);
    ctx.accounts.table.bank_limit_bps = bps;
    Ok(())
}

/// The owner names a new dealer; anyone may apply it EXIT_WINDOW_SECS later. Until then it is public and every investor
/// can leave first: a dealer chooses when rounds lock and can cancel one, so a stolen owner key must not bring in its
/// own dealer at once. Naming the current dealer calls a pending change off.
pub fn handle_propose_dealer(ctx: Context<OwnerOnly>, dealer: Pubkey) -> Result<()> {
    let t = &mut ctx.accounts.table;
    if dealer == t.dealer {
        t.pending_dealer = Pubkey::default();
        t.dealer_change_at = 0;
    } else {
        t.pending_dealer = dealer;
        t.dealer_change_at = Clock::get()?.unix_timestamp.checked_add(EXIT_WINDOW_SECS).ok_or(RouletteError::Overflow)?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyChange<'info> {
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
}

/// Only between rounds: a round is locked by the dealer that opened it.
pub fn handle_apply_dealer(ctx: Context<ApplyChange>) -> Result<()> {
    let t = &mut ctx.accounts.table;
    require!(t.pending_dealer != Pubkey::default(), RouletteError::NoPendingChange);
    require!(Clock::get()?.unix_timestamp >= t.dealer_change_at, RouletteError::TooEarlyToChange);
    require!(between_rounds(t), RouletteError::RoundRunning);
    t.dealer = t.pending_dealer;
    t.pending_dealer = Pubkey::default();
    t.dealer_change_at = 0;
    Ok(())
}

/// The owner names a new owner, which may accept with its own key EXIT_WINDOW_SECS later (a mistyped key changes nothing,
/// and a handover the owner was tricked into signing is public for a day, while the owner can call it off by naming
/// itself).
pub fn handle_propose_owner(ctx: Context<OwnerOnly>, new_owner: Pubkey) -> Result<()> {
    let t = &mut ctx.accounts.table;
    if new_owner == t.owner {
        t.pending_owner = Pubkey::default();
        t.owner_change_at = 0;
    } else {
        t.pending_owner = new_owner;
        t.owner_change_at = Clock::get()?.unix_timestamp.checked_add(EXIT_WINDOW_SECS).ok_or(RouletteError::Overflow)?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptOwner<'info> {
    pub new_owner: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump,
        constraint = table.pending_owner != Pubkey::default() && table.pending_owner == new_owner.key() @ RouletteError::NotPendingOwner)]
    pub table: Box<Account<'info, Table>>,
}

pub fn handle_accept_owner(ctx: Context<AcceptOwner>) -> Result<()> {
    let t = &mut ctx.accounts.table;
    require!(Clock::get()?.unix_timestamp >= t.owner_change_at, RouletteError::TooEarlyToChange);
    t.owner = t.pending_owner;
    t.pending_owner = Pubkey::default();
    t.owner_change_at = 0;
    Ok(())
}

/// Paused: no new rounds. Deposits, withdrawals, settlements and refunds keep working. After a cancelled round the table
/// stays paused EXIT_WINDOW_SECS (Table::resume_at), so cancelling the rounds one would lose cannot be repeated before
/// every investor could leave; a pause the owner chose ends whenever the owner likes.
pub fn handle_set_paused(ctx: Context<OwnerOnly>, paused: bool) -> Result<()> {
    let t = &mut ctx.accounts.table;
    if !paused { require!(Clock::get()?.unix_timestamp >= t.resume_at, RouletteError::TooEarlyToResume); }
    t.paused = paused;
    Ok(())
}

/// A new throw library (its hash and size) — only between rounds, so no round's throw index changes meaning.
pub fn handle_set_library(ctx: Context<OwnerOnly>, hash: [u8; 32], throw_count: u32) -> Result<()> {
    require!(throw_count >= 1, RouletteError::NoThrows);
    let t = &mut ctx.accounts.table;
    require!(between_rounds(t), RouletteError::RoundRunning);
    t.library_hash = hash;
    t.throw_count = throw_count;
    Ok(())
}
