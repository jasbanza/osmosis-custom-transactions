import { encodeSecp256k1Pubkey } from "@cosmjs/amino";
import { encodePubkey, type EncodeObject } from "@cosmjs/proto-signing";
import {
  AminoTypes,
  SigningStargateClient,
  createDefaultAminoConverters,
  type StdFee,
} from "@cosmjs/stargate";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { AuthInfo, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { getSigningOsmosisClientOptions, osmosisAminoConverters } from "osmojs";
import { formatCoin } from "./assets";
import { FEE_DENOM, RPC, getAccountInfo, getBalance, getBaseFee, lcd } from "./chain";
import type { BuiltTx } from "./txs/types";
import type { Wallet } from "./wallet";

const { registry } = getSigningOsmosisClientOptions();
// osmojs only ships Osmosis amino converters; bank sends need the cosmjs defaults too.
const aminoTypes = new AminoTypes({ ...createDefaultAminoConverters(), ...osmosisAminoConverters });

const SIM_FEE_PAYER = "osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmcn030";

type TxEvent ={ type: string; attributes: { key: string; value: string }[] };

export type SimResult = { gasUsed: number; events: TxEvent[] };

/** Runs the tx against current chain state via the LCD. No wallet prompt. */
export async function simulate(wallet: Wallet, tx: BuiltTx): Promise<SimResult> {
  const { sequence } = await getAccountInfo(wallet.address);
  const body = TxBody.fromPartial({
    messages: tx.msgs.map((m) => registry.encodeAsAny(m)),
    memo: tx.memo,
  });
  const authInfo = AuthInfo.fromPartial({
    signerInfos: [
      {
        publicKey: encodePubkey(encodeSecp256k1Pubkey(wallet.pubKey)),
        modeInfo: { single: { mode: SignMode.SIGN_MODE_DIRECT } },
        sequence,
      },
    ],
    fee: { amount: [], gasLimit: 0n },
  });
  const txBytes = TxRaw.encode(
    TxRaw.fromPartial({
      bodyBytes: TxBody.encode(body).finish(),
      authInfoBytes: AuthInfo.encode(authInfo).finish(),
      signatures: [new Uint8Array()],
    })
  ).finish();
  const r = await lcd<{ gas_info: { gas_used: string }; result: { events: TxEvent[] } }>(
    "/cosmos/tx/v1beta1/simulate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx_bytes: toBase64(txBytes) }),
    }
  );
  return { gasUsed: Number(r.gas_info.gas_used), events: r.result.events };
}

export async function estimateFee(gasUsed: number): Promise<StdFee> {
  const gas = Math.ceil(gasUsed * 1.4);
  const baseFee = await getBaseFee();
  const amount = Math.ceil(gas * baseFee * 1.5);
  return { amount: [{ denom: FEE_DENOM, amount: String(amount) }], gas: String(gas) };
}

/** Checks the wallet can cover the fee plus any OSMO the tx itself sends out. */
export async function checkFeeFunds(wallet: Wallet, tx: BuiltTx, fee: StdFee) {
  const outflow = tx.msgs
    .filter((m) => m.typeUrl === "/cosmos.bank.v1beta1.MsgSend" && m.value.fromAddress === wallet.address)
    .flatMap((m) => m.value.amount as { denom: string; amount: string }[])
    .filter((c) => c.denom === FEE_DENOM)
    .reduce((sum, c) => sum + BigInt(c.amount), 0n);
  const need = outflow + BigInt(fee.amount[0].amount);
  const have = await getBalance(wallet.address, FEE_DENOM);
  if (have < need) {
    throw new Error(
      `Not enough OSMO: this needs ${formatCoin(need, FEE_DENOM)} including the fee, the wallet has ${formatCoin(have, FEE_DENOM)}.`
    );
  }
}

/** Opens the wallet prompt, then broadcasts. Returns the tx hash once the mempool accepts it. */
export async function signAndBroadcast(wallet: Wallet, tx: BuiltTx, fee: StdFee): Promise<string> {
  const client = await SigningStargateClient.connectWithSigner(RPC, wallet.signer, {
    registry,
    aminoTypes,
  });
  const signed = await client.sign(wallet.address, tx.msgs as EncodeObject[], fee, tx.memo);
  const r = await lcd<{ tx_response: { txhash: string; code: number; raw_log: string } }>(
    "/cosmos/tx/v1beta1/txs",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tx_bytes: toBase64(TxRaw.encode(signed).finish()),
        mode: "BROADCAST_MODE_SYNC",
      }),
    }
  );
  if (r.tx_response.code !== 0) throw new Error(`Rejected before inclusion: ${r.tx_response.raw_log}`);
  return r.tx_response.txhash;
}

export type Landed = { height: string; code: number; rawLog: string; events: TxEvent[] };

/** Polls until the tx is included in a block. Returns undefined on timeout. */
export async function waitForTx(hash: string, timeoutMs = 90_000): Promise<Landed | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await lcd<{
        tx_response: { height: string; code: number; raw_log: string; events: TxEvent[] };
      }>(`/cosmos/tx/v1beta1/txs/${hash}`);
      const t = r.tx_response;
      return { height: t.height, code: t.code, rawLog: t.raw_log, events: t.events };
    } catch {
      // Not indexed yet.
    }
  }
  return undefined;
}

/** Turns the events that move funds into readable lines. */
export function describeEvents(events: TxEvent[], wallet: string): string[] {
  const lines: string[] = [];
  for (const e of events) {
    const a = Object.fromEntries(e.attributes.map((x) => [x.key, x.value]));
    // Simulation charges a placeholder fee from the all-zero address; it isn't a real transfer.
    if (e.type === "transfer" && a.amount && a.sender !== SIM_FEE_PAYER) {
      const who = (addr: string) => (addr === wallet ? "you" : short(addr));
      lines.push(`Transfer: ${who(a.sender)} → ${who(a.recipient)}: ${formatCoins(a.amount)}`);
    } else if (e.type === "pool_exited") {
      lines.push(`Pool ${a.pool_id} exit paid out: ${formatCoins(a.tokens_out)}`);
    } else if (e.type === "pool_joined") {
      lines.push(`Pool ${a.pool_id} join took in: ${formatCoins(a.tokens_in)}`);
    } else if (e.type === "token_swapped") {
      lines.push(`Pool ${a.pool_id} swap: ${formatCoins(a.tokens_in)} in, ${formatCoins(a.tokens_out)} out`);
    }
  }
  return lines;
}

function formatCoins(s: string): string {
  return s
    .split(",")
    .map((part) => {
      const m = part.match(/^(\d+)(.+)$/);
      return m ? formatCoin(m[1], m[2]) : part;
    })
    .join(" + ");
}

export const short = (addr: string) => `${addr.slice(0, 10)}…${addr.slice(-6)}`;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
