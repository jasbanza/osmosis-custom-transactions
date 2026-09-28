# Osmosis custom transactions

A single-page dapp for Osmosis transactions that the regular apps can't build, so they would otherwise need the `osmosisd` CLI. Connect Keplr, pick a transaction from the dropdown, fill in the form, simulate it against the live chain, then sign.

Live at https://jasbanza.github.io/osmosis-custom-transactions/

## Supported transactions

**Send tokens.** Sends any token the connected wallet holds to a pasted address. This includes pool shares (`gamm/pool/N`) and unlisted tokens that Keplr or app.osmosis.zone don't show. The address is checksum-validated, and the page warns when the destination is a pool, module or contract account rather than a wallet.

**Restore GAMM pool reserve and exit.** This is for a GAMM pool whose on-chain record claims more of a token than the pool's account actually holds, which makes normal withdrawals fail with `insufficient funds`. One transaction sends the missing amount to the pool and then withdraws your shares, so there's no window where the top-up can be arbitraged away. Check pool shows the record against the actual holdings for every asset before you build anything.

Link straight to a transaction with `?tx=<id>`, for example `?tx=restore-exit&pool=3393`.

## How each transaction runs

1. **Simulate** runs the exact messages against current chain state through the LCD. It never opens a wallet prompt. It shows the estimated gas and every transfer the transaction would make.
2. **Sign & broadcast** is enabled only after a successful simulation of the current form. It opens Keplr, which shows the messages for approval. Ledger accounts sign over amino.
3. The page waits for the tx to land in a block, reports success or the failure reason, and re-checks the result on chain.

## Safety

- Never share your seed phrase or private key with anyone, including this page. It only ever asks Keplr to sign.
- Read the messages Keplr shows before approving.
- Everything runs in your browser against `lcd.osmosis.zone` and `rpc.osmosis.zone`. There's no backend.

## Adding a transaction

Add a module in `src/txs/` that implements `TxBuilder` from `src/txs/types.ts`, and register it in `BUILDERS` in `src/main.ts`. A builder provides:

- a description and `whenToUse` scenarios,
- a form renderer,
- `build()`, which returns the messages,
- and optionally `verify()`, which runs after the tx lands.

Simulating, signing and landing detection are shared.

## Development

```
npm install
npm run dev
npm run build
```

Pushing to `main` deploys to GitHub Pages through `.github/workflows/deploy.yml`.
