use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use crate::errors::RouletteError;
use crate::instructions::pay_from_vault;
use crate::state::*;

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(address = table.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump = table.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = wallet)]
    pub wallet_token: Account<'info, TokenAccount>,
    #[account(init_if_needed, payer = wallet, space = 8 + Safe::INIT_SPACE, seeds = [SAFE_SEED, table.key().as_ref(), wallet.key().as_ref()], bump)]
    pub safe: Account<'info, Safe>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Moves `amount` from the wallet's token account into its safe (the safe is created on the first deposit).
pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, RouletteError::ZeroAmount);
    let a = &ctx.accounts;
    token::transfer_checked(CpiContext::new(a.token_program.to_account_info(), TransferChecked {
        from: a.wallet_token.to_account_info(), mint: a.mint.to_account_info(), to: a.vault.to_account_info(), authority: a.wallet.to_account_info(),
    }), amount, a.mint.decimals)?;
    let safe = &mut ctx.accounts.safe;
    safe.wallet = ctx.accounts.wallet.key();
    safe.bump = ctx.bumps.safe;
    safe.balance = safe.balance.checked_add(amount).ok_or(RouletteError::Overflow)?;
    let t = &mut ctx.accounts.table;
    t.safes_total = t.safes_total.checked_add(amount).ok_or(RouletteError::Overflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub wallet: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(address = table.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, table.key().as_ref()], bump = table.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = wallet)]
    pub wallet_token: Account<'info, TokenAccount>,
    #[account(mut, seeds = [SAFE_SEED, table.key().as_ref(), wallet.key().as_ref()], bump = safe.bump)]
    pub safe: Account<'info, Safe>,
    pub token_program: Program<'info, Token>,
}

/// Sends `amount` from the safe back to a token account of the safe's own wallet (never while a stake is in a round).
pub fn handle_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, RouletteError::ZeroAmount);
    require!(ctx.accounts.safe.pending_round == 0, RouletteError::StakeInRound);
    require!(ctx.accounts.safe.balance >= amount, RouletteError::InsufficientSafe);
    ctx.accounts.safe.balance -= amount;
    ctx.accounts.table.safes_total = ctx.accounts.table.safes_total.checked_sub(amount).ok_or(RouletteError::Overflow)?;
    let a = &ctx.accounts;
    pay_from_vault(&a.table, &a.vault, &a.wallet_token, &a.mint, &a.token_program, amount)
}
