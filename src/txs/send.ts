import { fromBech32 } from "@cosmjs/encoding";
import { cosmos } from "osmojs";
import { assetInfo, formatAmount, formatCoin, parseAmount } from "../assets";
import { BECH32_PREFIX, getBalance, getBalances, type Coin } from "../chain";
import { $, esc, input } from "../ui";
import type { Ctx, TxBuilder } from "./types";

const { send } = cosmos.bank.v1beta1.MessageComposer.withTypeUrl;

let el: HTMLElement;
let balances: Coin[] = [];
let lastSend: { to: string; denom: string; before: bigint } | undefined;

export const sendTokens: TxBuilder = {
  id: "send",
  label: "Send tokens",
  description:
    "Send any token the connected wallet holds, including pool shares (gamm/pool/N) that Keplr may not display, to a pasted address.",
  whenToUse: [
    "Moving LP shares (gamm/pool/N) between your own wallets, for example to put all of a pool's shares in one wallet before withdrawing.",
    "Sending a token that Keplr or app.osmosis.zone doesn't list, so their send screens don't show it.",
    "Funding another of your wallets with the exact tokens a follow-up transaction needs.",
  ],

  render(root, ctx) {
    el = root;
    el.innerHTML = `
      <label>Token
        <select id="send-denom"><option value="">Loading balances…</option></select>
      </label>
      <label>Amount
        <div class="row">
          <input id="send-amount" inputmode="decimal" placeholder="0.0" autocomplete="off" />
          <button type="button" id="send-max" class="secondary">Max</button>
        </div>
        <small id="send-unit"></small>
      </label>
      <label>Destination address
        <input id="send-to" placeholder="osmo1…" autocomplete="off" spellcheck="false" />
        <small id="send-to-note"></small>
      </label>`;

    const denomSel = $(el, "#send-denom") as HTMLSelectElement;
    const amount = input(el, "#send-amount");
    const to = input(el, "#send-to");

    getBalances(ctx.wallet.address).then((coins) => {
      balances = coins.filter((c) => BigInt(c.amount) > 0n);
      denomSel.innerHTML = balances.length
        ? balances
            .map((c) => `<option value="${esc(c.denom)}">${esc(formatCoin(c.amount, c.denom))}</option>`)
            .join("")
        : `<option value="">This wallet holds no tokens</option>`;
      updateUnit();
    });

    const updateUnit = () => {
      const info = assetInfo(denomSel.value);
      $(el, "#send-unit").textContent = denomSel.value
        ? `${denomSel.value}${info.known ? "" : " (unlisted token: amount is in raw base units)"}`
        : "";
      ctx.invalidate();
    };

    denomSel.addEventListener("change", updateUnit);
    amount.addEventListener("input", ctx.invalidate);
    to.addEventListener("input", () => {
      $(el, "#send-to-note").textContent = describeDestination(to.value.trim(), ctx.wallet.address);
      ctx.invalidate();
    });
    $(el, "#send-max").addEventListener("click", () => {
      const coin = balances.find((c) => c.denom === denomSel.value);
      if (coin) amount.value = formatAmount(coin.amount, assetInfo(coin.denom).decimals).replace(/,/g, "");
      ctx.invalidate();
    });
  },

  async build(ctx) {
    const denom = ($(el, "#send-denom") as HTMLSelectElement).value;
    if (!denom) throw new Error("Pick a token");
    const coin = balances.find((c) => c.denom === denom)!;
    const amount = parseAmount(input(el, "#send-amount").value, assetInfo(denom).decimals);
    if (amount <= 0n) throw new Error("Amount must be greater than zero");
    if (amount > BigInt(coin.amount)) throw new Error(`The wallet only holds ${formatCoin(coin.amount, denom)}`);

    const to = input(el, "#send-to").value.trim();
    validateAddress(to);

    lastSend = { to, denom, before: await getBalance(to, denom) };
    return {
      msgs: [
        send({
          fromAddress: ctx.wallet.address,
          toAddress: to,
          amount: [{ denom, amount: amount.toString() }],
        }),
      ],
      memo: "",
      summary: [`Send ${formatCoin(amount, denom)} to ${to}`],
    };
  },

  async verify() {
    if (!lastSend) return [];
    const after = await getBalance(lastSend.to, lastSend.denom);
    return [
      `Destination balance of ${assetInfo(lastSend.denom).symbol}: ${formatCoin(lastSend.before, lastSend.denom)} before, ${formatCoin(after, lastSend.denom)} now.`,
    ];
  },
};

function validateAddress(addr: string) {
  let decoded;
  try {
    decoded = fromBech32(addr);
  } catch {
    throw new Error("Destination is not a valid address (checksum failed or it was mistyped)");
  }
  if (decoded.prefix !== BECH32_PREFIX) throw new Error(`Destination must be an ${BECH32_PREFIX}1… address`);
}

function describeDestination(addr: string, self: string): string {
  if (!addr) return "";
  try {
    const { prefix, data } = fromBech32(addr);
    if (prefix !== BECH32_PREFIX) return `Not an ${BECH32_PREFIX}1… address.`;
    if (addr === self) return "This is the connected wallet itself.";
    // Wallets are 20-byte addresses; pools, modules and contracts are 32 bytes.
    if (data.length === 32)
      return "⚠ This is a pool, module or contract account, not a regular wallet. Tokens sent here usually cannot be withdrawn by you.";
    return "Valid wallet address.";
  } catch {
    return "Invalid address: the checksum fails, so it is probably mistyped or missing a character.";
  }
}
