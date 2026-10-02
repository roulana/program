use anchor_lang::prelude::*;

pub mod derive;
pub mod errors;
pub mod instructions;
pub mod rules;
pub mod spots;
pub mod state;

use instructions::*;

declare_id!("7FqVwLDtBPC1YsKpiXUw8HxCJP63hqQKGFcnYXgYgHBn");

#[program]
pub mod roulette {
    use super::*;

    /// The program's version (a harmless call used to check the build end to end).
    pub fn version(_ctx: Context<Version>) -> Result<()> {
        msg!("roulette {}", env!("CARGO_PKG_VERSION"));
        Ok(())
    }

    pub fn init_table(ctx: Context<InitTable>, owner: Pubkey, dealer: Pubkey, fee_bps: u16, bank_limit_bps: u16, library_hash: [u8; 32], throw_count: u32) -> Result<()> {
        instructions::table::handle_init_table(ctx, owner, dealer, fee_bps, bank_limit_bps, library_hash, throw_count)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> { instructions::safe::handle_deposit(ctx, amount) }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> { instructions::safe::handle_withdraw(ctx, amount) }

    pub fn open_session(ctx: Context<OpenSession>, key: Pubkey, cap: u64, expires_at: i64) -> Result<()> {
        instructions::session::handle_open_session(ctx, key, cap, expires_at)
    }

    pub fn close_session(ctx: Context<CloseSession>) -> Result<()> { instructions::session::handle_close_session(ctx) }

    pub fn open_round(ctx: Context<OpenRound>, commitment: [u8; 32]) -> Result<()> { instructions::round::handle_open_round(ctx, commitment) }

    pub fn place_bets(ctx: Context<PlaceBets>, bets: Vec<state::Bet>) -> Result<()> { instructions::round::handle_place_bets(ctx, bets) }

    pub fn lock_round(ctx: Context<LockRound>) -> Result<()> { instructions::round::handle_lock_round(ctx) }

    pub fn reveal(ctx: Context<Reveal>, seed: [u8; 32]) -> Result<()> { instructions::round::handle_reveal(ctx, seed) }

    pub fn forfeit(ctx: Context<Forfeit>) -> Result<()> { instructions::round::handle_forfeit(ctx) }

    pub fn settle(ctx: Context<Settle>) -> Result<()> { instructions::round::handle_settle(ctx) }

    pub fn void_round(ctx: Context<VoidRound>) -> Result<()> { instructions::round::handle_void_round(ctx) }

    pub fn refund(ctx: Context<Refund>) -> Result<()> { instructions::round::handle_refund(ctx) }

    pub fn close_bets(ctx: Context<CloseBets>) -> Result<()> { instructions::round::handle_close_bets(ctx) }

    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> { instructions::round::handle_close_round(ctx) }

    pub fn invest(ctx: Context<Invest>, amount: u64) -> Result<()> { instructions::pool::handle_invest(ctx, amount) }

    pub fn request_withdrawal(ctx: Context<RequestWithdrawal>, shares: u64) -> Result<()> { instructions::pool::handle_request_withdrawal(ctx, shares) }

    pub fn execute_withdrawal(ctx: Context<ExecuteWithdrawal>) -> Result<()> { instructions::pool::handle_execute_withdrawal(ctx) }

    pub fn set_fee(ctx: Context<OwnerOnly>, bps: u16) -> Result<()> { instructions::owner::handle_set_fee(ctx, bps) }

    pub fn set_bank_limit(ctx: Context<OwnerOnly>, bps: u16) -> Result<()> { instructions::owner::handle_set_bank_limit(ctx, bps) }

    pub fn propose_dealer(ctx: Context<OwnerOnly>, dealer: Pubkey) -> Result<()> { instructions::owner::handle_propose_dealer(ctx, dealer) }

    pub fn apply_dealer(ctx: Context<ApplyChange>) -> Result<()> { instructions::owner::handle_apply_dealer(ctx) }

    pub fn propose_owner(ctx: Context<OwnerOnly>, new_owner: Pubkey) -> Result<()> { instructions::owner::handle_propose_owner(ctx, new_owner) }

    pub fn accept_owner(ctx: Context<AcceptOwner>) -> Result<()> { instructions::owner::handle_accept_owner(ctx) }

    pub fn set_paused(ctx: Context<OwnerOnly>, paused: bool) -> Result<()> { instructions::owner::handle_set_paused(ctx, paused) }

    pub fn set_library(ctx: Context<OwnerOnly>, hash: [u8; 32], throw_count: u32) -> Result<()> { instructions::owner::handle_set_library(ctx, hash, throw_count) }

    pub fn pay_buyback(ctx: Context<PayBuyback>) -> Result<()> { instructions::buyback::handle_pay_buyback(ctx) }

    pub fn propose_buyback(ctx: Context<ProposeBuyback>) -> Result<()> { instructions::buyback::handle_propose_buyback(ctx) }

    pub fn apply_buyback(ctx: Context<ApplyBuyback>) -> Result<()> { instructions::buyback::handle_apply_buyback(ctx) }
}

#[derive(Accounts)]
pub struct Version {}
