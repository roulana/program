use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use crate::errors::RouletteError;
use crate::instructions::pay_from_vault;
use crate::rules::{cost_of, shares_for, value_of};
use crate::state::*;

/// Money may join the pool unless a round's randomness may already be visible on-chain (Locked); it may leave only
/// between rounds — not while bets the bank limit allowed are on the table (Open), nor while Locked.
fn between_rounds(t: &Table) -> bool { matches!(t.round_status, RoundStatus::None | RoundStatus::Revealed | RoundStatus::Voided) }

#[derive(Accounts)]
pub struct Invest<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(address = table.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump = table.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = investor)]
    pub investor_token: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = investor, space = 8 + Position::INIT_SPACE, seeds = [POSITION_SEED, table.key().as_ref(), investor.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Buys as many whole shares as `amount` (at least $100) pays for at the current share value, and takes only what they
/// cost: rounding can never hand part of an investment to the other investors.
pub fn handle_invest(ctx: Context<Invest>, amount: u64) -> Result<()> {
    require!(amount > 0, RouletteError::ZeroAmount);
    let t = &ctx.accounts.table;
    require!(t.round_status != RoundStatus::Locked, RouletteError::RoundRunning);
    require!(amount >= MIN_INVEST_DOLLARS.checked_mul(t.unit).ok_or(RouletteError::Overflow)?, RouletteError::BelowMinimum);
    let shares = shares_for(amount, t.pool, t.total_shares)?;
    require!(shares > 0, RouletteError::NoShares);
    let cost = cost_of(shares, t.pool, t.total_shares)?;
    let a = &ctx.accounts;
    token::transfer_checked(CpiContext::new(a.token_program.to_account_info(), TransferChecked {
        from: a.investor_token.to_account_info(), mint: a.mint.to_account_info(), to: a.vault.to_account_info(), authority: a.investor.to_account_info(),
    }), cost, a.mint.decimals)?;
    let t = &mut ctx.accounts.table;
    t.pool = t.pool.checked_add(cost).ok_or(RouletteError::Overflow)?;
    t.total_shares = t.total_shares.checked_add(shares).ok_or(RouletteError::Overflow)?;
    let now = Clock::get()?.unix_timestamp;
    let table = ctx.accounts.table.key();
    let p = &mut ctx.accounts.position;
    let new = p.investor == Pubkey::default();                        // a position just created: all zero
    p.table = table;
    p.investor = ctx.accounts.investor.key();
    p.bump = ctx.bumps.position;
    p.shares = p.shares.checked_add(shares).ok_or(RouletteError::Overflow)?;
    p.invested = p.invested.checked_add(cost).ok_or(RouletteError::Overflow)?;
    if new { p.joined_at = now; }
    Ok(())
}

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
    pub investor: Signer<'info>,
    #[account(seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, seeds = [POSITION_SEED, table.key().as_ref(), investor.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
}

/// Gives notice for `shares`; a new request restarts the notice for all pending shares.
pub fn handle_request_withdrawal(ctx: Context<RequestWithdrawal>, shares: u64) -> Result<()> {
    require!(shares > 0, RouletteError::ZeroAmount);
    let p = &mut ctx.accounts.position;
    let pending = p.pending_shares.checked_add(shares).ok_or(RouletteError::Overflow)?;
    require!(pending <= p.shares, RouletteError::InsufficientShares);
    p.pending_shares = pending;
    p.unlock_at = Clock::get()?.unix_timestamp.checked_add(NOTICE_SECS).ok_or(RouletteError::Overflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteWithdrawal<'info> {
    pub investor: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(address = table.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump = table.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = investor)]
    pub investor_token: Account<'info, TokenAccount>,
    #[account(mut, seeds = [POSITION_SEED, table.key().as_ref(), investor.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
    pub token_program: Program<'info, Token>,
}

/// After the notice, between rounds: pays the pending shares at the share value of this moment.
pub fn handle_execute_withdrawal(ctx: Context<ExecuteWithdrawal>) -> Result<()> {
    let pending = ctx.accounts.position.pending_shares;
    require!(pending > 0, RouletteError::NoShares);
    require!(Clock::get()?.unix_timestamp >= ctx.accounts.position.unlock_at, RouletteError::NoticeNotPassed);
    require!(between_rounds(&ctx.accounts.table), RouletteError::RoundRunning);
    let t = &mut ctx.accounts.table;
    let amount = value_of(pending, t.pool, t.total_shares);
    t.pool -= amount;                                                // value_of never exceeds the pool
    t.total_shares -= pending;                                       // pending ≤ the position's shares ≤ total
    let p = &mut ctx.accounts.position;
    p.shares -= pending;
    p.pending_shares = 0;
    p.withdrawn = p.withdrawn.checked_add(amount).ok_or(RouletteError::Overflow)?;
    let a = &ctx.accounts;
    pay_from_vault(&a.table, &a.vault, &a.investor_token, &a.mint, &a.token_program, amount)
}
