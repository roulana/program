#!/usr/bin/env python3
"""Check Roulana's books, straight from Solana: is every dollar the table owes in its vault? Nothing to install: Python 3.8
or newer.

    python3 check-bank.py

It reads two accounts in one question, so both are from the same moment: the table (the program's own books) and the
vault (the USDC account the program holds). The program keeps, in the table, what it owes: the players' safes, the bank
(the investors' money), the bets of the round in play, wins not yet paid, and the buyback half of the fee that waits for
the coin. Their sum must be in the vault. The vault can hold more than that only if someone sent USDC to it directly.

Options: --rpc <url> to ask another Solana node; --table <address> and --vault <address> for another table.
Exit code: 0 every dollar is there, 1 the vault holds less than the books, 2 wrong use or Solana did not answer.
"""
import base64
import json
import struct
import sys
import urllib.error
import urllib.request

RPC = "https://api.mainnet-beta.solana.com"
PROGRAM = "7FqVwLDtBPC1YsKpiXUw8HxCJP63hqQKGFcnYXgYgHBn"
TABLE = "AfyXCSmsshBZ998TCCNbuUSB5hcw4RnJFeEk1LWhh63J"
VAULT = "BPJmrTZFCBi4iK6bA4FxV43wM1qQqiHXBGMHbfd4aw56"
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

# The table account as the program lays it out (Anchor, borsh): an 8-byte discriminator, then its fields in order.
# Offsets of the u64 amounts used here (units of the mint: USDC has 6 decimals).
MINT_AT = 72          # after the discriminator (8), the owner (32) and the dealer (32)
POOL_AT = 162         # the bank
SAFES_AT = 178        # every player's safe
ESCROW_AT = 186       # the bets of the round in play
OWED_AT = 194         # wins and refunds not yet paid into the safes
BUYBACK_OWED_AT = 258 # the buyback half of the fee, waiting in the vault
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(raw):
    n = int.from_bytes(raw, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + out


def ask(rpc, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(rpc, data=body, headers={"content-type": "application/json", "user-agent": "roulana-check-bank"})
    with urllib.request.urlopen(req, timeout=30) as r:
        answer = json.load(r)
    if "error" in answer:
        raise RuntimeError(answer["error"].get("message", str(answer["error"])))
    return answer["result"]


def u64(data, at):
    return struct.unpack_from("<Q", data, at)[0]


def dollars(units):
    return "${:,.2f}".format(units / 1_000_000)


def main(argv):
    rpc, table, vault = RPC, TABLE, VAULT
    args = list(argv)
    while args:
        flag = args.pop(0)
        if flag in ("--rpc", "--table", "--vault") and args:
            value = args.pop(0)
            if flag == "--rpc":
                rpc = value
            elif flag == "--table":
                table = value
            else:
                vault = value
        else:
            print("Use: python3 check-bank.py [--rpc <url>] [--table <address> --vault <address>]")
            return 2
    try:
        result = ask(rpc, "getMultipleAccounts", [[table, vault], {"encoding": "base64", "commitment": "confirmed"}])
    except (urllib.error.URLError, RuntimeError, TimeoutError, ValueError) as e:
        print("Solana did not answer ({}). Try again later, or ask another node with --rpc.".format(e))
        return 2
    t, v = result["value"]
    if t is None or v is None:
        print("The table or the vault does not exist at these addresses.")
        return 2
    if t["owner"] != PROGRAM or v["owner"] != TOKEN_PROGRAM:
        print("These are not Roulana's table and vault: the table must belong to the program {}.".format(PROGRAM))
        return 2
    td, vd = base64.b64decode(t["data"][0]), base64.b64decode(v["data"][0])
    if b58encode(vd[0:32]) != b58encode(td[MINT_AT:MINT_AT + 32]):
        print("The vault does not hold the table's money (another mint).")
        return 2
    held = u64(vd, 64)
    parts = [
        ("Players' safes", u64(td, SAFES_AT)),
        ("The bank (investors)", u64(td, POOL_AT)),
        ("Bets of the round in play", u64(td, ESCROW_AT)),
        ("Wins not yet paid out", u64(td, OWED_AT)),
        ("Buyback, waiting for the coin", u64(td, BUYBACK_OWED_AT)),
    ]
    owed = sum(units for _, units in parts)
    print("Roulana's books on Solana, read at slot {} (the table and the vault at the same moment):".format(result["context"]["slot"]))
    for name, units in parts:
        print("  {:<32}{:>16}".format(name, dollars(units)))
    print("  {:<32}{:>16}".format("Owed in all", dollars(owed)))
    print("  {:<32}{:>16}".format("In the vault", dollars(held)))
    if held == owed:
        print("✓ Every dollar the table owes is in the vault, to the cent.")
        return 0
    if held > owed:
        print("✓ Every dollar the table owes is in the vault, and {} more: USDC someone sent to the vault directly.".format(dollars(held - owed)))
        return 0
    print("✗ The vault holds {} less than the table owes.".format(dollars(owed - held)))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
