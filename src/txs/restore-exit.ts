import { cosmos, osmosis } from "osmojs";
import { assetInfo, formatCoin } from "../assets";
import { getBalance, getBalances, getPool, poolRecord, type Coin } from "../chain";
import { $, esc, input } from "../ui";
import type { Ctx, TxBuilder } from "./types";

const { send } = cosmos.bank.v1beta1.MessageComposer.withTypeUrl;
const { exitPool } = osmosis.gamm.v1beta1.MessageComposer.withTypeUrl;

// The chain refuses to exit 100% of a pool's shares, so a sole holder leaves this much behind.
const DUST_SHARES = 10n ** 12n;

type Analysis = {
  poolId: string;
  poolAddress: string;
  rows: { denom: string; record: bigint; bank: bigint; shortfall: bigint; walletHas: bigint }[];
  totalShares: bigint;
  userShares: bigint;
  shareIn: bigint;
  expectedOut: Coin[];
};

let el: HTMLElement;

export const restoreExit: TxBuilder = {
  id: "restore-exit",
  label: "Restore GAMM pool reserve and exit",
  description:
    "For a GAMM pool whose on-chain record claims more tokens than its account holds, so normal withdrawals fail. In one transaction this sends the missing amount to the pool and then withdraws your shares.",
  whenToUse: [
    "Remove Liquidity fails with an \"insufficient funds\" error, or the pool shows $0 liquidity or won't load on app.osmosis.zone.",
    "Check pool shows a shortfall: the pool's record says it holds more of a token than it actually does (for example pool 3393 after 2026-09-21).",
    "You hold shares in that pool and can cover the shortfall. The shortfall is usually tiny, and when you hold every share you get almost all of it back in the same withdrawal.",
    "Not needed for healthy pools: if Check pool shows no shortfall, withdraw on app.osmosis.zone as normal.",
  ],

  render(root, ctx) {
    el = root;
    el.innerHTML = `
      <label>Pool ID
        <div class="row">
          <input id="re-pool" inputmode="numeric" placeholder="e.g. 3393" autocomplete="off" />
          <button type="button" id="re-load" class="secondary">Check pool</button>
        </div>
      </label>
      <label>Slippage tolerance on the payout (%)
        <input id="re-slip" value="0.5" inputmode="decimal" />
      </label>
      <p class="warn">Do not send the missing tokens to the pool on their own. At the pool's broken price they can be arbitraged away within a few blocks, and the pool can end up drained again. Topping up and withdrawing in the same transaction leaves no window for that.</p>
      <div id="re-report"></div>`;

    const report = $(el, "#re-report");
    const load = async () => {
      ctx.invalidate();
      report.innerHTML = "<p>Checking pool…</p>";
      try {
        report.innerHTML = renderReport(await analyze(ctx));
      } catch (e) {
        report.innerHTML = `<p class="error">${esc((e as Error).message)}</p>`;
      }
    };
    $(el, "#re-load").addEventListener("click", load);
    input(el, "#re-pool").addEventListener("keydown", (e) => e.key === "Enter" && load());
    input(el, "#re-pool").addEventListener("input", ctx.invalidate);
    input(el, "#re-slip").addEventListener("input", ctx.invalidate);
  },

  async build(ctx) {
    // Always re-read chain state so the signed amounts match the latest block.
    const a = await analyze(ctx);
    $(el, "#re-report").innerHTML = renderReport(a);
    if (a.userShares === 0n) throw new Error(`This wallet holds no pool ${a.poolId} shares.`);
    const topUp = a.rows.filter((r) => r.shortfall > 0n);
    if (topUp.length === 0) {
      throw new Error(
        `Pool ${a.poolId} has no shortfall, so a normal withdrawal on app.osmosis.zone will work. This tool is only needed when the pool is short.`
      );
    }
    const missing = topUp.filter((r) => r.walletHas < r.shortfall);
    if (missing.length) {
      throw new Error(
        "The wallet doesn't hold enough to cover the shortfall: " +
          missing.map((r) => `needs ${formatCoin(r.shortfall, r.denom)}, has ${formatCoin(r.walletHas, r.denom)}`).join("; ") +
          ". Use Send tokens to move the difference here from another wallet first."
      );
    }

    const slipBps = BigInt(Math.round(parseFloat(input(el, "#re-slip").value) * 100));
    if (!(slipBps >= 0n && slipBps < 10_000n)) throw new Error("Slippage must be between 0 and 100");
    const tokenOutMins = a.expectedOut.map((c) => ({
      denom: c.denom,
      amount: ((BigInt(c.amount) * (10_000n - slipBps)) / 10_000n).toString(),
    }));

    const topUpCoins = topUp.map((r) => ({ denom: r.denom, amount: r.shortfall.toString() }));
    return {
      msgs: [
        send({ fromAddress: ctx.wallet.address, toAddress: a.poolAddress, amount: topUpCoins }),
        exitPool({
          sender: ctx.wallet.address,
          poolId: BigInt(a.poolId),
          shareInAmount: a.shareIn.toString(),
          tokenOutMins,
        }),
      ],
      memo: `Restore pool ${a.poolId} reserve and exit`,
      summary: [
        `1. Send ${topUpCoins.map((c) => formatCoin(c.amount, c.denom)).join(" + ")} to pool ${a.poolId} (${a.poolAddress}) to cover the shortfall.`,
        `2. Withdraw ${formatCoin(a.shareIn, `gamm/pool/${a.poolId}`)} from pool ${a.poolId}, expecting about ${a.expectedOut.map((c) => formatCoin(c.amount, c.denom)).join(" + ")} (minimum ${tokenOutMins.map((c) => formatCoin(c.amount, c.denom)).join(" + ")}).`,
      ],
    };
  },

  async verify(ctx) {
    const a = await analyze(ctx);
    const lines = a.rows.map(
      (r) =>
        `Pool ${a.poolId} ${assetInfo(r.denom).symbol}: record ${formatCoin(r.record, r.denom)}, held ${formatCoin(r.bank, r.denom)}${r.shortfall > 0n ? ` (still short ${formatCoin(r.shortfall, r.denom)})` : " (matches)"}`
    );
    lines.push(`Your remaining pool ${a.poolId} shares: ${formatCoin(a.userShares, `gamm/pool/${a.poolId}`)}`);
    return lines;
  },
};

async function analyze(ctx: Ctx): Promise<Analysis> {
  const poolId = input(el, "#re-pool").value.trim();
  if (!/^\d+$/.test(poolId)) throw new Error("Enter a numeric pool ID");
  const pool = await getPool(poolId);
  if (!pool["@type"].startsWith("/osmosis.gamm.")) {
    throw new Error(`Pool ${poolId} is not a GAMM (weighted or stableswap) pool; this tool only handles those.`);
  }
  const record = poolRecord(pool);
  const bank = await getBalances(pool.address);
  const rows = await Promise.all(
    record.map(async (c) => {
      const rec = BigInt(c.amount);
      const held = BigInt(bank.find((b) => b.denom === c.denom)?.amount ?? "0");
      const shortfall = rec > held ? rec - held : 0n;
      const walletHas = shortfall > 0n ? await getBalance(ctx.wallet.address, c.denom) : 0n;
      return { denom: c.denom, record: rec, bank: held, shortfall, walletHas };
    })
  );
  const totalShares = BigInt(pool.total_shares.amount);
  const userShares = await getBalance(ctx.wallet.address, `gamm/pool/${poolId}`);
  const shareIn = userShares >= totalShares ? totalShares - DUST_SHARES : userShares;
  // After the top-up the pool's holdings match its record, so the exit pays out a pro-rata share of the record.
  const expectedOut = rows.map((r) => ({ denom: r.denom, amount: ((r.record * shareIn) / totalShares).toString() }));
  return { poolId, poolAddress: pool.address, rows, totalShares, userShares, shareIn, expectedOut };
}

function renderReport(a: Analysis): string {
  const pct = a.totalShares ? Number((a.userShares * 1_000_000n) / a.totalShares) / 10_000 : 0;
  const shareDenom = `gamm/pool/${a.poolId}`;
  const table = `
    <table>
      <thead><tr><th>Asset</th><th>Pool record</th><th>Actually held</th><th>Shortfall</th></tr></thead>
      <tbody>${a.rows
        .map(
          (r) => `<tr class="${r.shortfall > 0n ? "short" : ""}">
            <td title="${esc(r.denom)}">${esc(assetInfo(r.denom).symbol)}</td>
            <td>${esc(formatCoin(r.record, r.denom))}</td>
            <td>${esc(formatCoin(r.bank, r.denom))}</td>
            <td>${r.shortfall > 0n ? esc(formatCoin(r.shortfall, r.denom)) : "none"}</td></tr>`
        )
        .join("")}</tbody>
    </table>`;
  const healthy = a.rows.every((r) => r.shortfall === 0n);
  const position =
    a.userShares === 0n
      ? `<p class="error">This wallet holds no pool ${esc(a.poolId)} shares.</p>`
      : `<p>You hold ${esc(formatCoin(a.userShares, shareDenom))}, which is ${pct}% of the pool.${
          a.userShares >= a.totalShares
            ? ` Because you hold every share, the withdrawal leaves ${esc(formatCoin(DUST_SHARES, shareDenom))} behind; the chain refuses a 100% exit.`
            : " The top-up covers the whole shortfall, so part of it stays in the pool for the other shareholders."
        }</p>`;
  return `${table}${healthy ? `<p>No shortfall: this pool is healthy and a normal withdrawal will work.</p>` : ""}${position}`;
}
