//! The table's money rules, pure (no accounts): bet validation, what the pool owes for each number, payouts, fee.
use crate::errors::RouletteError;
use crate::spots::SPOTS;
use crate::state::{Bet, MAX_BETS, MAX_ROUND_DOLLARS};

type R<T> = core::result::Result<T, RouletteError>;

/// Checks a player's whole bet set for one round; returns its total in dollars.
pub fn check_bets(bets: &[Bet]) -> R<u64> {
    if bets.is_empty() { return Err(RouletteError::NoBets); }
    if bets.len() > MAX_BETS { return Err(RouletteError::TooManyBets); }
    let mut per_spot = [0u64; SPOTS.len()];
    let mut total = 0u64;
    for b in bets {
        let spot = SPOTS.get(b.spot as usize).ok_or(RouletteError::UnknownSpot)?;
        if b.dollars == 0 { return Err(RouletteError::InvalidAmount); }
        per_spot[b.spot as usize] += b.dollars as u64;
        if per_spot[b.spot as usize] > spot.max_dollars as u64 { return Err(RouletteError::SpotLimit); }
        total += b.dollars as u64;
    }
    if total > MAX_ROUND_DOLLARS { return Err(RouletteError::RoundLimit); }
    Ok(total)
}

/// Adds what the pool would pay (stake back + winnings) for each winning number.
pub fn add_liabilities(liab: &mut [u64; 37], bets: &[Bet], unit: u64) -> R<()> {
    for b in bets {
        let spot = &SPOTS[b.spot as usize];
        let pays = (b.dollars as u64).checked_mul(unit).and_then(|s| s.checked_mul(spot.payout + 1)).ok_or(RouletteError::Overflow)?;
        for n in 0..37 {
            if spot.mask & (1u64 << n) != 0 { liab[n] = liab[n].checked_add(pays).ok_or(RouletteError::Overflow)?; }
        }
    }
    Ok(())
}

/// What a player's bets pay back when `number` wins (stake back + winnings), in base units.
pub fn payout(bets: &[Bet], number: u8, unit: u64) -> u64 {
    bets.iter()
        .filter(|b| SPOTS[b.spot as usize].mask & (1u64 << number) != 0)
        .map(|b| b.dollars as u64 * unit * (SPOTS[b.spot as usize].payout + 1))
        .sum()
}

/// The owner's fee on `stake`.
pub fn fee(stake: u64, fee_bps: u16) -> u64 {
    (stake as u128 * fee_bps as u128 / 10_000) as u64
}

/// How a fee is split: exactly half (rounded down) is set aside for the public buyback, the rest goes to the owner.
/// Fixed in the program — nobody can change it. Returns (to_owner, to_buyback).
pub fn split_fee(fee: u64) -> (u64, u64) {
    let buyback = fee / 2;
    (fee - buyback, buyback)
}

/// The most the pool can lose in this round: the worst number's payout plus the fee, minus the stakes it takes in.
pub fn worst_loss(liab: &[u64; 37], total_stake: u64, fee: u64) -> u64 {
    let worst = *liab.iter().max().unwrap_or(&0);
    worst.saturating_add(fee).saturating_sub(total_stake)
}

/// Shares for depositing `amount` into a pool of `pool` with `total_shares` (1 share per base unit when empty).
pub fn shares_for(amount: u64, pool: u64, total_shares: u64) -> R<u64> {
    if total_shares == 0 { return Ok(amount); }
    if pool == 0 { return Err(RouletteError::PoolEmpty); }
    u64::try_from(amount as u128 * total_shares as u128 / pool as u128).map_err(|_| RouletteError::Overflow)
}

/// What `shares` cost to buy now (rounded up: rounding favours the pool, by less than one base unit). With
/// `shares = shares_for(amount, …)` it never exceeds `amount`: an investor pays only for whole shares.
pub fn cost_of(shares: u64, pool: u64, total_shares: u64) -> R<u64> {
    if total_shares == 0 { return Ok(shares); }
    u64::try_from((shares as u128 * pool as u128).div_ceil(total_shares as u128)).map_err(|_| RouletteError::Overflow)
}

/// What `shares` are worth now (rounded down: rounding always favours the pool).
pub fn value_of(shares: u64, pool: u64, total_shares: u64) -> u64 {
    if total_shares == 0 { return 0; }
    (shares as u128 * pool as u128 / total_shares as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    const UNIT: u64 = 1_000_000;
    fn bet(spot: u8, dollars: u32) -> Bet { Bet { spot, dollars } }
    const RED: u8 = 151;          // position of "red" in the engine catalogue (checked below)

    #[test]
    fn the_fee_splits_in_half_and_nothing_is_lost() {
        assert_eq!(split_fee(0), (0, 0));
        assert_eq!(split_fee(1), (1, 0));
        assert_eq!(split_fee(101), (51, 50));
        assert_eq!(split_fee(10_000_000), (5_000_000, 5_000_000));
        for fee in [3u64, 999, 1_234_567, u64::MAX] {
            let (owner, buyback) = split_fee(fee);
            assert_eq!(owner + buyback, fee);
            assert!(owner >= buyback && owner - buyback <= 1);
        }
    }

    #[test]
    fn the_catalogue_matches_the_engine_positions() {
        assert_eq!(SPOTS.len(), 157);
        assert_eq!(SPOTS[17].mask, 1 << 17);
        assert_eq!(SPOTS[17].payout, 35);
        assert_eq!(SPOTS[RED as usize].payout, 1);
        assert_eq!(SPOTS[RED as usize].mask.count_ones(), 18);
        assert_eq!(SPOTS[RED as usize].max_dollars, 2_000);
    }

    #[test]
    fn limits() {
        assert_eq!(check_bets(&[bet(17, 100)]), Ok(100));
        assert_eq!(check_bets(&[bet(17, 60), bet(17, 41)]), Err(RouletteError::SpotLimit));
        assert_eq!(check_bets(&[bet(RED, 2_000), bet(RED + 1, 2_000), bet(RED + 2, 2_000), bet(RED + 3, 2_000), bet(RED + 4, 2_000), bet(0, 1)]), Err(RouletteError::RoundLimit));
        assert_eq!(check_bets(&[]), Err(RouletteError::NoBets));
        assert_eq!(check_bets(&[bet(157, 1)]), Err(RouletteError::UnknownSpot));
        assert_eq!(check_bets(&[bet(3, 0)]), Err(RouletteError::InvalidAmount));
        assert_eq!(check_bets(&vec![bet(0, 1); 65]), Err(RouletteError::TooManyBets));
    }

    #[test]
    fn payouts_and_liabilities() {
        let bets = [bet(17, 10), bet(RED, 20)];
        assert_eq!(payout(&bets, 17, UNIT), 360 * UNIT);        // 17 is black: only the straight wins, 10 × 36
        assert_eq!(payout(&bets, 1, UNIT), 40 * UNIT);           // 1 is red: 20 × 2
        assert_eq!(payout(&bets, 0, UNIT), 0);
        let mut liab = [0u64; 37];
        add_liabilities(&mut liab, &bets, UNIT).unwrap();
        for n in 0..37u8 { assert_eq!(liab[n as usize], payout(&bets, n, UNIT)); }
        assert_eq!(worst_loss(&liab, 30 * UNIT, fee(30 * UNIT, 50)), 330 * UNIT + 150_000);
        assert_eq!(fee(1_000_000, 50), 5_000);
    }

    #[test]
    fn shares() {
        assert_eq!(shares_for(1_000, 0, 0), Ok(1_000));
        assert_eq!(shares_for(500, 2_000, 1_000), Ok(250));             // the pool doubled: half as many shares per dollar
        assert_eq!(shares_for(1, 0, 10), Err(RouletteError::PoolEmpty));
        assert_eq!(shares_for(u64::MAX, 1, u64::MAX), Err(RouletteError::Overflow));
        assert_eq!(value_of(250, 2_500, 1_250), 500);
        assert_eq!(value_of(1, 10, 3), 3);                               // rounds down: rounding favours the pool
        assert_eq!(value_of(5, 0, 0), 0);
        assert_eq!(value_of(u64::MAX, u64::MAX, u64::MAX), u64::MAX);    // no overflow in the product
    }

    #[test]
    fn an_investment_costs_only_its_whole_shares() {
        assert_eq!(cost_of(1_000, 0, 0), Ok(1_000));                     // an empty bank: one share per base unit
        assert_eq!(cost_of(250, 2_000, 1_000), Ok(500));
        // one share worth 81.500001: $160 buys 1 share for 81.500001, $170 buys 2 for 163.000002
        assert_eq!(shares_for(160_000_000, 81_500_001, 1), Ok(1));
        assert_eq!(cost_of(1, 81_500_001, 1), Ok(81_500_001));
        assert_eq!(cost_of(shares_for(170_000_000, 81_500_001, 1).unwrap(), 81_500_001, 1), Ok(163_000_002));
        assert_eq!(cost_of(1, 10, 3), Ok(4));                            // 3.33 rounds up: the pool never loses
        for (amount, pool, total) in [(1_000_000u64, 3_333_333u64, 1_000_000u64), (123_456_789, 999_999_999, 7), (u64::MAX / 4, u64::MAX / 2, u64::MAX / 2)] {
            let shares = shares_for(amount, pool, total).unwrap();
            let cost = cost_of(shares, pool, total).unwrap();
            assert!(cost <= amount, "never more than offered");
            assert!(value_of(shares, pool + cost, total + shares) + 1 >= cost, "worth what it cost, within a base unit");
        }
    }
}
