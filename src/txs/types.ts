import type { EncodeObject } from "@cosmjs/proto-signing";
import type { Wallet } from "../wallet";

export type Ctx = {
  wallet: Wallet;
  /** Call whenever a form input changes, so a stale simulation can't be signed. */
  invalidate: () => void;
};

export type BuiltTx = {
  msgs: EncodeObject[];
  memo: string;
  /** Plain-language description of each message, shown before simulating and signing. */
  summary: string[];
};

export interface TxBuilder {
  id: string;
  label: string;
  description: string;
  /** Scenarios shown on the page so it's clear when this transaction is the right tool. */
  whenToUse: string[];
  render(el: HTMLElement, ctx: Ctx): void;
  build(ctx: Ctx): Promise<BuiltTx>;
  /** Post-landing checks, run once the tx is included in a block. */
  verify?(ctx: Ctx): Promise<string[]>;
}
