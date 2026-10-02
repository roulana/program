use anchor_lang::prelude::*;
use crate::errors::RouletteError;
use crate::state::*;

#[derive(Accounts)]
pub struct OpenSession<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(init_if_needed, payer = wallet, space = 8 + Session::INIT_SPACE, seeds = [SESSION_SEED, table.key().as_ref(), wallet.key().as_ref()], bump)]
    pub session: Account<'info, Session>,
    pub system_program: Program<'info, System>,
}

/// Lets `key` (a key kept by the browser) place bets for this wallet, up to `cap` in total, until `expires_at`.
/// Replaces any earlier session of the wallet.
pub fn handle_open_session(ctx: Context<OpenSession>, key: Pubkey, cap: u64, expires_at: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(expires_at > now, RouletteError::SessionExpired);
    require!(expires_at - now <= MAX_SESSION_SECS, RouletteError::SessionTooLong);
    let s = &mut ctx.accounts.session;
    s.wallet = ctx.accounts.wallet.key();
    s.key = key;
    s.cap_remaining = cap;
    s.expires_at = expires_at;
    s.bump = ctx.bumps.session;
    Ok(())
}

#[derive(Accounts)]
pub struct CloseSession<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(seeds = [TABLE_SEED, table.mint.as_ref()], bump = table.bump)]
    pub table: Box<Account<'info, Table>>,
    #[account(mut, close = wallet, seeds = [SESSION_SEED, table.key().as_ref(), wallet.key().as_ref()], bump = session.bump)]
    pub session: Account<'info, Session>,
}

/// Ends the session: the browser key can no longer bet (the account's rent returns to the wallet).
pub fn handle_close_session(_ctx: Context<CloseSession>) -> Result<()> { Ok(()) }
