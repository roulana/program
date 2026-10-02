# Reporting a security problem

If you find a way to take money that is not yours, change a bet or a payout, choose a number, or stop the table,
please tell us privately first:

- on GitHub: **Security → Report a vulnerability** in this repository (it stays private), or
- by email: **support@roulana.com**.

Please do not post it in public, and do not try it on the live table: it holds real money. Show it with a test instead:
the tests in `client/test` run the program in LiteSVM, a Solana runtime on your own computer, and many of them play an
attack through to the end (`hardening.test.ts`, `fixes.test.ts`). We read every report.
