use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::errors::RouletteError;
use crate::instructions::pay_from_vault;
use crate::state::*;

/// Sends what is set aside for the buyback to the public buyback account. Anyone may call it. It touches nothing else,
/// so a closed or frozen buyback account can only stop this — never a round.
#[derive(Accounts)]
pub struct PayBuyback<'info> {
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(address = table.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump = table.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, address = table.buyback_token @ RouletteError::WrongBuybackAccount)]
    pub buyback_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_pay_buyback(ctx: Context<PayBuyback>) -> Result<()> {
    let t = &mut ctx.accounts.table;
    let amount = t.buyback_owed;
    t.buyback_owed = 0;
    t.buyback_paid = t.buyback_paid.checked_add(amount).ok_or(RouletteError::Overflow)?;
    let a = &ctx.accounts;
    pay_from_vault(&a.table, &a.vault, &a.buyback_token, &a.mint, &a.token_program, amount)
}

/// The owner names a new buyback account; anyone may apply it once 7 days have passed, so the change is public first.
/// Naming the current account cancels a pending change.
#[derive(Accounts)]
pub struct ProposeBuyback<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump, has_one = owner @ RouletteError::NotOwner)]
    pub table: Box<Account<'info, Table>>,
    /// Of the table's currency, and never an account the table itself holds (the vault): money sent there would be
    /// stuck and still reported as sent.
    #[account(constraint = new_buyback_token.mint == table.mint && new_buyback_token.owner != table.key() @ RouletteError::WrongBuybackAccount)]
    pub new_buyback_token: Account<'info, TokenAccount>,
}

pub fn handle_propose_buyback(ctx: Context<ProposeBuyback>) -> Result<()> {
    let new = ctx.accounts.new_buyback_token.key();
    let t = &mut ctx.accounts.table;
    if new == t.buyback_token {
        t.pending_buyback_token = Pubkey::default();
        t.buyback_change_at = 0;
    } else {
        t.pending_buyback_token = new;
        t.buyback_change_at = Clock::get()?.unix_timestamp.checked_add(BUYBACK_NOTICE_SECS).ok_or(RouletteError::Overflow)?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyBuyback<'info> {
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
}

pub fn handle_apply_buyback(ctx: Context<ApplyBuyback>) -> Result<()> {
    let t = &mut ctx.accounts.table;
    require!(t.pending_buyback_token != Pubkey::default(), RouletteError::NoPendingChange);
    require!(Clock::get()?.unix_timestamp >= t.buyback_change_at, RouletteError::TooEarlyToChange);
    t.buyback_token = t.pending_buyback_token;
    t.pending_buyback_token = Pubkey::default();
    t.buyback_change_at = 0;
    Ok(())
}
