//! The round's result from its randomness (the sealed seed and a later slot's hash) — the same algorithm as
//! packages/engine/src/outcome.ts — and the entropy slot read from the SlotHashes sysvar.
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Outcome { pub number: u8, pub throw_index: u32 }

/// 32-bit big-endian words of HMAC-SHA256(key = randomness, "roulette3:<round_id>:<counter>"), counter 0, 1, 2 …
struct Words<'a> { key: &'a [u8; 64], round_id: u64, counter: u64, buf: [u8; 32], pos: usize }

impl Words<'_> {
    fn next(&mut self) -> u32 {
        if self.pos == 32 {
            let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(self.key).expect("HMAC takes any key length");
            mac.update(format!("roulette3:{}:{}", self.round_id, self.counter).as_bytes());
            self.buf.copy_from_slice(&mac.finalize().into_bytes());
            self.counter += 1;
            self.pos = 0;
        }
        let w = u32::from_be_bytes([self.buf[self.pos], self.buf[self.pos + 1], self.buf[self.pos + 2], self.buf[self.pos + 3]]);
        self.pos += 4;
        w
    }
}

/// Uniform integer in [0, n) by rejection sampling, so no value is favoured.
fn uniform(w: &mut Words, n: u32) -> u32 {
    let n = n as u64;
    let limit = (1u64 << 32) / n * n;
    loop {
        let x = w.next() as u64;
        if x < limit { return (x % n) as u32; }
    }
}

/// The winning number (0–36) and the recorded throw to show (0 … throw_count − 1).
pub fn derive_outcome(randomness: &[u8; 64], round_id: u64, throw_count: u32) -> Outcome {
    let mut w = Words { key: randomness, round_id, counter: 0, buf: [0; 32], pos: 32 };
    let number = uniform(&mut w, 37) as u8;
    let throw_index = uniform(&mut w, throw_count.max(1));
    Outcome { number, throw_index }
}

/// Lowercase hex of 32 bytes: the block hash in a round's receipt.
pub fn hex32(b: &[u8; 32]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(64);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

/// The sealed envelope: what the dealer publishes when the round opens.
pub fn commitment(seed: &[u8; 32]) -> [u8; 32] {
    Sha256::digest(seed).into()
}

/// The round's randomness: the dealer's seed followed by the entropy slot's hash.
pub fn round_key(seed: &[u8; 32], slot_hash: &[u8; 32]) -> [u8; 64] {
    let mut k = [0u8; 64];
    k[..32].copy_from_slice(seed);
    k[32..].copy_from_slice(slot_hash);
    k
}

/// Where the entropy slot stands in the SlotHashes history.
#[derive(Debug, PartialEq, Eq)]
pub enum Entropy {
    /// The first slot at or after the target, with its hash.
    Found(u64, [u8; 32]),
    /// The history does not reach the target yet (it only holds slots before the current one): try again shortly.
    NotYet,
    /// The history no longer reaches back before the target, so nobody can prove which slot was the first.
    Gone,
}

/// In the SlotHashes sysvar's data (u64 count, then (slot u64, hash 32 bytes), newest first): the first slot at or
/// after `min_slot`. An entry counts only when an older entry follows it (proof that no earlier slot ≥ `min_slot` exists).
pub fn entropy_after(sysvar: &[u8], min_slot: u64) -> Entropy {
    let entry = |i: usize| -> Option<(u64, [u8; 32])> {
        let e = sysvar.get(8 + i * 40..8 + i * 40 + 40)?;
        Some((u64::from_le_bytes(e[..8].try_into().ok()?), e[8..].try_into().ok()?))
    };
    let count = sysvar.get(..8).and_then(|c| c.try_into().ok()).map_or(0, |c| u64::from_le_bytes(c) as usize);
    let mut found = None;
    for i in 0..count {
        let Some((slot, hash)) = entry(i) else { break };
        if slot < min_slot {
            return match found { Some((s, h)) => Entropy::Found(s, h), None => Entropy::NotYet };
        }
        found = Some((slot, hash));
    }
    if found.is_some() { Entropy::Gone } else { Entropy::NotYet }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> { (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap()).collect() }

    #[test]
    fn matches_the_engine_vectors() {
        let raw = include_str!("../../../../packages/engine/test/outcome-vectors.json");
        let vectors: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        assert!(vectors.len() >= 20);
        for v in vectors {
            let r: [u8; 64] = hex(v["randomness"].as_str().unwrap()).try_into().unwrap();
            let round: u64 = v["roundId"].as_str().unwrap().parse().unwrap();
            let got = derive_outcome(&r, round, v["throwCount"].as_u64().unwrap() as u32);
            assert_eq!(got, Outcome { number: v["number"].as_u64().unwrap() as u8, throw_index: v["throwIndex"].as_u64().unwrap() as u32 }, "round {round}");
        }
    }

    /// Captured from the engine: commitmentOf(32 × 9).
    const COMMITMENT_9: &str = "8c0cc17a04942cc4f8e0fe0b302606d3108860c126428ba2ceeb5f9ed41c2b05";

    #[test]
    fn commitment_matches_the_engine() {
        assert_eq!(commitment(&[9; 32]).to_vec(), hex(COMMITMENT_9));
        assert_eq!(&round_key(&[1; 32], &[2; 32])[..], &[[1u8; 32], [2u8; 32]].concat()[..]);
    }

    fn sysvar(entries: &[(u64, u8)]) -> Vec<u8> {
        let mut d = (entries.len() as u64).to_le_bytes().to_vec();
        for (slot, h) in entries { d.extend(slot.to_le_bytes()); d.extend([*h; 32]); }
        d
    }

    #[test]
    fn the_entropy_slot_is_the_first_one_at_or_after_the_target() {
        let s = sysvar(&[(105, 5), (104, 4), (102, 2), (101, 1)]);        // 103 was skipped (no block)
        assert_eq!(entropy_after(&s, 102), Entropy::Found(102, [2; 32]));
        assert_eq!(entropy_after(&s, 103), Entropy::Found(104, [4; 32])); // a skipped slot: the next one counts
        assert_eq!(entropy_after(&s, 106), Entropy::NotYet);               // not in the history yet: retry, never give up
        assert_eq!(entropy_after(&s, 50), Entropy::Gone);                  // older than the history
        assert_eq!(entropy_after(&s, 101), Entropy::Gone);                 // the oldest entry: no proof an earlier slot is not missing
        assert_eq!(entropy_after(&[], 1), Entropy::NotYet);
    }

    #[test]
    fn hex32_is_lowercase_hex_both_nibbles() {
        let mut b = [0u8; 32];
        b[0] = 0xab;
        b[1] = 0x0f;
        b[31] = 0xf0;
        let h = hex32(&b);
        assert_eq!(h.len(), 64);
        assert!(h.starts_with("ab0f00"));
        assert!(h.ends_with("00f0"));
    }
}
