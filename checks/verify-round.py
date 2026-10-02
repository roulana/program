#!/usr/bin/env python3
"""Check a Roulana round with money on it, straight from Solana. Nothing to install: Python 3.8 or newer.

    python3 verify-round.py <round address>

The round address is in every "Check" link on roulana.com (.../verify?round=<address>). This script reads the round's
transactions from a public Solana node, never from Roulana's server, and checks, in order:

  1. the round belongs to Roulana's table (its opening transaction names the table);
  2. the fingerprint (SHA-256 of the dealer's secret seed) was sealed on Solana before the first bet;
  3. betting closed;
  4. the seed revealed afterwards matches the fingerprint;
  5. the block mixed in was made after betting closed (the program's receipt in the reveal transaction);
  6. the formula gives the number the program published and paid:
     HMAC-SHA256 keyed with seed + block hash (64 bytes) over "roulette3:<round id>:<counter>", counter 0, 1, 2 ...,
     read as 32-bit big-endian numbers, turned into 0-36 by rejection sampling.

Options: --rpc <url> to ask another Solana node.  Exit code: 0 checked, 1 a check failed or not a Roulana round,
2 wrong use or Solana did not answer.
"""
import hashlib
import hmac
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

PROGRAM = "7FqVwLDtBPC1YsKpiXUw8HxCJP63hqQKGFcnYXgYgHBn"
TABLE = "AfyXCSmsshBZ998TCCNbuUSB5hcw4RnJFeEk1LWhh63J"
RPC = "https://api.mainnet-beta.solana.com"
NETWORK = "mainnet"

USAGE = "Use: python3 verify-round.py <round address>   (the address is in every Check link on roulana.com)"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


class Unavailable(Exception):
    """The Solana node did not answer: try again later. Never a guess."""


class TooMany(Exception):
    """More transactions name the address than a public node lets anyone read. Said plainly, never a guess."""


def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\0" * (len(s) - len(s.lstrip("1"))) + raw


def is_address(s):
    return bool(re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}", s)) and len(b58decode(s)) == 32


def discriminator(name):
    """The first 8 bytes of each instruction's data (Anchor: sha256 of "global:<name>")."""
    return hashlib.sha256(("global:" + name).encode()).digest()[:8]


KINDS = {discriminator(n): k for n, k in [("open_round", "open"), ("place_bets", "bets"), ("lock_round", "lock"),
                                          ("reveal", "reveal"), ("forfeit", "forfeit"), ("void_round", "void")]}
# Where each instruction names the table and the round (the program checks both: the round is the table's). Only an
# instruction with this round and this table in these places concerns them: anyone may append any address to their own
# transactions, and anyone may open rounds on a table of their own in the same program.
AT = {"open": (1, 2), "bets": (2, 3), "lock": (1, 2), "reveal": (0, 1), "forfeit": (0, 1), "void": (0, 1)}


def kind_for(i, round_address):
    """What a Roulana instruction does to this round of Roulana's table, if anything."""
    if i["program"] != PROGRAM:
        return None
    k = KINDS.get(i["data"][:8])
    if not k:
        return None
    table_at, round_at = AT[k]
    a = i["accounts"]
    return k if len(a) > max(table_at, round_at) and a[round_at] == round_address and a[table_at] == TABLE else None


def rpc(url, method, params):
    """One JSON-RPC call. A busy public node (about 10 transaction reads per 10 seconds) is waited for, as long as it asks."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    wait, unreachable = 0, 0
    for attempt in range(8):
        if attempt:
            time.sleep(wait)
        wait = min(8.0, 0.5 * 2 ** attempt)
        try:
            req = urllib.request.Request(url, body, {"content-type": "application/json", "user-agent": "verify-round.py"})
            with urllib.request.urlopen(req, timeout=30) as r:
                answer = json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                after = e.headers.get("retry-after") if e.headers else None
                if after and after.isdigit() and int(after) > 0:
                    wait = min(10.0, float(after))
                continue
            raise Unavailable("Solana answered %d" % e.code)
        except (urllib.error.URLError, OSError, ValueError):
            unreachable += 1
            if unreachable >= 3:
                break
            continue
        if "error" in answer:
            continue
        return answer.get("result")
    raise Unavailable("Solana did not answer")


BEFORE_OPEN, MAX_READS, MAX_PAGES, PAGE = 20, 60, 5, 1000


def round_transactions(url, round_address):
    """The round's successful transactions, oldest first, up to its end (reveal, forfeit or void): slot, time,
    instructions, logs. Failed ones never count, and the payouts after the end are not checked, so neither is read.
    Bounded: no opening among the first 20, or more than 60 to read, is "could not check" (anyone may put transactions
    before a round's opening: its address is known in advance), never "not a round"."""
    sigs = []
    for page in range(MAX_PAGES + 1):
        if page == MAX_PAGES:
            raise TooMany()
        params = {"limit": PAGE, "commitment": "confirmed"}
        if sigs:
            params["before"] = sigs[-1]["signature"]
        got = rpc(url, "getSignaturesForAddress", [round_address, params]) or []
        sigs += got
        if len(got) < PAGE:
            break
    txs, opened = [], False
    for s in sorted((s for s in sigs if s.get("err") is None), key=lambda s: s["slot"]):
        if not opened and len(txs) == BEFORE_OPEN:
            raise TooMany()
        if len(txs) == MAX_READS:
            raise TooMany()
        t = rpc(url, "getTransaction", [s["signature"], {"encoding": "json", "maxSupportedTransactionVersion": 0, "commitment": "confirmed"}])
        if not t or not t.get("meta"):
            raise Unavailable("Solana does not have transaction %s yet" % s["signature"])
        loaded = t["meta"].get("loadedAddresses") or {"writable": [], "readonly": []}
        keys = t["transaction"]["message"]["accountKeys"] + loaded["writable"] + loaded["readonly"]
        txs.append({
            "signature": s["signature"], "slot": t["slot"], "time": t.get("blockTime"), "ok": t["meta"]["err"] is None,
            "logs": t["meta"].get("logMessages") or [],
            "instructions": [{"program": keys[i["programIdIndex"]], "accounts": [keys[a] for a in i["accounts"]],
                              "data": b58decode(i["data"])} for i in t["transaction"]["message"]["instructions"]],
        })
        last = txs[-1]
        if not last["ok"]:
            continue
        kinds = [kind_for(i, round_address) for i in last["instructions"]]
        opened = opened or "open" in kinds
        if opened and any(k in ("reveal", "forfeit", "void") for k in kinds):
            break
    return txs


REVEALED = re.compile(r"receipt: round (\d{1,20}) number (\d{1,2}) throw (\d{1,10}) block (\d{1,20}) hash ([0-9a-f]{64})")
ENDED = re.compile(r"receipt: round (\d{1,20}) (forfeited|voided)")


def receipt_of(logs):
    """The program's receipt: only a line printed inside the Roulana program's own (outermost) invocation."""
    stack = []
    for line in logs:
        m = re.fullmatch(r"Program (\w+) invoke \[\d+\]", line)
        if m:
            stack.append(m.group(1))
            continue
        if re.match(r"Program \w+ (success|failed)", line):
            if stack:
                stack.pop()
            continue
        if stack != [PROGRAM] or not line.startswith("Program log: receipt: "):
            continue
        text = line[len("Program log: "):]
        m = REVEALED.fullmatch(text)
        if m:
            if int(m.group(2)) > 36:
                return None
            return {"id": int(m.group(1)), "kind": "revealed", "number": int(m.group(2)), "block": int(m.group(4)),
                    "hash": bytes.fromhex(m.group(5))}
        m = ENDED.fullmatch(text)
        return {"id": int(m.group(1)), "kind": m.group(2)} if m else None
    return None


LIMIT = (2 ** 32 // 37) * 37


def number_of(seed, block_hash, round_id):
    """The formula: the first 32-bit word below LIMIT, modulo 37."""
    counter = 0
    while True:
        h = hmac.new(seed + block_hash, ("roulette3:%d:%d" % (round_id, counter)).encode(), hashlib.sha256).digest()
        for i in range(0, 32, 4):
            x = int.from_bytes(h[i:i + 4], "big")
            if x < LIMIT:
                return x % 37
        counter += 1


def check(round_address, txs):
    """The same checks as roulana.com/verify: a list of (state, sentence) and the verdict line."""
    ours = []
    for t in txs:
        if not t["ok"]:
            continue
        for i in t["instructions"]:
            k = kind_for(i, round_address)
            if k:
                ours.append((t, i, k))
    first = lambda kind: next((x for x in ours if x[2] == kind), None)
    open_ = first("open")
    if not open_:
        return [], "not-a-round", None, "unknown"
    steps = [("pass", "This round belongs to Roulana’s table.")]
    bets = [x for x in ours if x[2] == "bets"]
    t_open = when(open_[0]["time"])
    if not bets:
        steps.append(("pass", "The fingerprint was sealed on Solana at %s, before any bet." % t_open))
    elif open_[0]["slot"] <= bets[0][0]["slot"]:  # a bet in the opening's block comes after it (the program takes none before)
        steps.append(("pass", "The fingerprint was sealed on Solana at %s, before the first bet (%s)." % (t_open, when(bets[0][0]["time"]))))
    else:
        steps.append(("fail", "The fingerprint was sealed at %s, AFTER a bet (%s)." % (t_open, when(bets[0][0]["time"]))))
    if first("void"):
        return steps, verdict(steps, "voided"), None, "voided"
    lock = first("lock")
    if not lock:
        return steps + [("none", "Betting has not closed yet.")], "partial", None, "running"
    steps.append(("pass", "Betting closed at %s." % when(lock[0]["time"])))
    if first("forfeit"):
        return steps, verdict(steps, "forfeited"), None, "forfeited"
    reveal = first("reveal")
    if not reveal:
        return steps, "partial", None, "running"
    seed, commitment = reveal[1]["data"][8:40], open_[1]["data"][8:40]
    t_reveal = when(reveal[0]["time"])
    if len(seed) == 32 and hashlib.sha256(seed).digest() == commitment:
        steps.append(("pass", "The seed revealed at %s matches the fingerprint." % t_reveal))
    else:
        steps.append(("fail", "The seed revealed at %s does NOT match the fingerprint." % t_reveal))
    r = receipt_of(reveal[0]["logs"])
    old = "The program started keeping this for good on 25 September 2026; for older rounds"
    if not r or r["kind"] != "revealed":
        steps.append(("none", old + " the block mixed in can’t be checked."))
        steps.append(("none", old + " the number can’t be recomputed from Solana alone."))
        return steps, verdict(steps, "revealed"), None, "revealed"
    lock_slot = lock[0]["slot"]
    if r["block"] >= lock_slot + 2:
        steps.append(("pass", "The block mixed in (%d) was made after betting closed (%d)." % (r["block"], lock_slot)))
    else:
        steps.append(("fail", "The block mixed in (%d) was NOT made after betting closed (%d)." % (r["block"], lock_slot)))
    computed = number_of(seed, r["hash"], r["id"]) if len(seed) == 32 else -1
    if computed == r["number"]:
        steps.append(("pass", "The formula gives %d, the number the program published and paid." % computed))
    else:
        steps.append(("fail", "The formula gives %d, but the program published %d." % (computed, r["number"])))
    return steps, verdict(steps, "revealed"), r["number"], "revealed"


def verdict(steps, outcome):
    if any(s == "fail" for s, _ in steps):
        return "failed"
    return "partial" if any(s == "none" for s, _ in steps) else "checked"


def outcome_text(v, number, outcome):
    if v == "not-a-round":
        return "This is not a round of Roulana’s table: no opening of a Roulana round was found in its history."
    if outcome == "forfeited":
        return "Betting closed but the number was not published in time: the round was cancelled, and every bet went back to its safe."
    if outcome == "voided":
        return "The round was called off before betting closed: every stake went back."
    if outcome == "running":
        return "This round is still running: check again in a minute."
    if v == "failed":
        return "A check FAILED."
    if v == "partial":
        return "Checked as far as Solana allows for this round: the number was %s." % (number if number is not None else "published before the receipt existed")
    return "Every check passed: the number was %d." % number


def when(t):
    return "an unknown time" if t is None else datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def main(argv):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass
    args, url = list(argv), RPC
    if "-h" in args or "--help" in args:
        print(__doc__)
        return 0
    if "--rpc" in args:
        i = args.index("--rpc")
        if i + 1 >= len(args):
            print(USAGE)
            return 2
        url = args[i + 1]
        del args[i:i + 2]
    if len(args) != 1 or not is_address(args[0]):
        print(USAGE)
        return 2
    round_address = args[0]
    print("Round %s on Solana %s" % (round_address, NETWORK))
    try:
        txs = round_transactions(url, round_address)
    except Unavailable as e:
        print("%s: try again in a minute (or use --rpc with another Solana node)." % e)
        return 2
    except TooMany:
        cluster = "?cluster=devnet" if NETWORK == "devnet" else ""
        print("Could not check this round: this address has too many transactions to read from a public Solana node. See it on Solana’s explorer instead:"
              " https://explorer.solana.com/address/%s%s" % (round_address, cluster))
        return 2
    steps, v, number, outcome = check(round_address, txs)
    mark = {"pass": "✓", "fail": "✗", "none": "–"}
    for state, sentence in steps:
        print("%s %s" % (mark[state], sentence))
    print(outcome_text(v, number, outcome))
    cluster = "?cluster=devnet" if NETWORK == "devnet" else ""
    print("On Solana's explorer: https://explorer.solana.com/address/%s%s" % (round_address, cluster))
    return 1 if v in ("failed", "not-a-round") else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
