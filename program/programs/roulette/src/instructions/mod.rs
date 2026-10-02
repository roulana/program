pub mod buyback;
pub mod owner;
pub mod pool;
pub mod round;
pub mod safe;
pub mod session;
pub mod table;

pub use buyback::*;
pub use owner::*;
pub use pool::*;
pub use round::*;
pub use safe::*;
pub use session::*;
pub use table::*;

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use crate::state::{Table, TABLE_SEED};

/// Pays `amount` out of the vault to `to` (the table's PDA signs).
pub fn pay_from_vault<'info>(
    table: &Account<'info, Table>, vault: &Account<'info, TokenAccount>, to: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>, token_program: &Program<'info, Token>, amount: u64,
) -> Result<()> {
    if amount == 0 { return Ok(()); }
    let seeds: &[&[u8]] = &[TABLE_SEED, table.mint.as_ref(), &[table.bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(token_program.to_account_info(), TransferChecked {
            from: vault.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: table.to_account_info(),
        }, &[seeds]),
        amount, mint.decimals,
    )
}
