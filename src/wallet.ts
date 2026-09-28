import type { Window as KeplrWindow } from "@keplr-wallet/types";
import type { OfflineSigner } from "@cosmjs/proto-signing";
import { CHAIN_ID } from "./chain";

declare global {
  interface Window extends KeplrWindow {}
}

export type Wallet = {
  address: string;
  name: string;
  pubKey: Uint8Array;
  isLedger: boolean;
  signer: OfflineSigner;
};

export async function connectKeplr(): Promise<Wallet> {
  const keplr = window.keplr;
  if (!keplr) throw new Error("Keplr is not installed. Install the Keplr extension and reload.");
  await keplr.enable(CHAIN_ID);
  const key = await keplr.getKey(CHAIN_ID);
  // Auto picks amino signing for Ledger accounts and direct signing otherwise.
  const signer = await keplr.getOfflineSignerAuto(CHAIN_ID);
  return {
    address: key.bech32Address,
    name: key.name,
    pubKey: key.pubKey,
    isLedger: key.isNanoLedger,
    // Keplr's bundled typings predate cosmjs 0.32's bigint SignDoc; the extension accepts both at runtime.
    signer: signer as unknown as OfflineSigner,
  };
}

export function onKeplrAccountChange(cb: () => void) {
  window.addEventListener("keplr_keystorechange", cb);
}
