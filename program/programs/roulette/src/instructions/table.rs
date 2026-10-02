use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::errors::RouletteError;
use crate::program::Roulette;
use crate::state::*;

/// Sets up the table for a currency (one per currency, for good). Only the program's upgrade authority may do it:
/// anyone else could otherwise take the one table of real USDC first (and USDC's mint authority is Circle, not us).
#[derive(Accounts)]
pub struct InitTable<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ RouletteError::NotUpgradeAuthority)]
    pub program: Program<'info, Roulette>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ RouletteError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = payer, space = 8 + Table::INIT_SPACE, seeds = [TABLE_SEED, mint.key().as_ref()], bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(init, payer = payer, seeds = [VAULT_SEED, table.key().as_ref()], bump, token::mint = mint, token::authority = table)]
    pub vault: Account<'info, TokenAccount>,
    /// The public buyback wallet's account for this currency — never one the table itself holds.
    #[account(token::mint = mint, constraint = buyback_token.owner != table.key() @ RouletteError::WrongBuybackAccount)]
    pub buyback_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_table(ctx: Context<InitTable>, owner: Pubkey, dealer: Pubkey, fee_bps: u16, bank_limit_bps: u16, library_hash: [u8; 32], throw_count: u32) -> Result<()> {
    require!(fee_bps <= FEE_CAP_BPS, RouletteError::FeeAboveCap);
    require!((BANK_LIMIT_MIN_BPS..=BANK_LIMIT_CAP_BPS).contains(&bank_limit_bps), RouletteError::BankLimitOutOfRange);
    require!(throw_count >= 1, RouletteError::NoThrows);
    let t = &mut ctx.accounts.table;
    t.owner = owner;
    t.dealer = dealer;
    t.mint = ctx.accounts.mint.key();
    t.unit = 10u64.checked_pow(ctx.accounts.mint.decimals as u32).ok_or(RouletteError::Overflow)?;
    t.fee_bps = fee_bps;
    t.bank_limit_bps = bank_limit_bps;
    t.library_hash = library_hash;
    t.throw_count = throw_count;
    t.round_status = RoundStatus::None;
    t.buyback_token = ctx.accounts.buyback_token.key();
    t.bump = ctx.bumps.table;
    t.vault_bump = ctx.bumps.vault;
    Ok(())
}
