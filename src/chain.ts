export const CHAIN_ID = "osmosis-1";
export const LCD = "https://lcd.osmosis.zone";
export const RPC = "https://rpc.osmosis.zone";
export const FEE_DENOM = "uosmo";
export const BECH32_PREFIX = "osmo";

export type Coin = { denom: string; amount: string };

export async function lcd<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(LCD + path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message ?? `${res.status} ${res.statusText} for ${path}`);
  }
  return body as T;
}

export async function getBalances(address: string): Promise<Coin[]> {
  const coins: Coin[] = [];
  let key: string | null = null;
  do {
    const q = new URLSearchParams({ "pagination.limit": "500" });
    if (key) q.set("pagination.key", key);
    const r = await lcd<{ balances: Coin[]; pagination: { next_key: string | null } }>(
      `/cosmos/bank/v1beta1/balances/${address}?${q}`
    );
    coins.push(...r.balances);
    key = r.pagination?.next_key ?? null;
  } while (key);
  return coins;
}

export async function getBalance(address: string, denom: string): Promise<bigint> {
  const r = await lcd<{ balance?: Coin }>(
    `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`
  );
  return BigInt(r.balance?.amount ?? "0");
}

/** Account number and sequence; a never-used address returns zeros. */
export async function getAccountInfo(address: string) {
  try {
    const r = await lcd<{ info: { account_number: string; sequence: string } }>(
      `/cosmos/auth/v1beta1/account_info/${address}`
    );
    return { accountNumber: BigInt(r.info.account_number), sequence: BigInt(r.info.sequence) };
  } catch {
    return { accountNumber: 0n, sequence: 0n };
  }
}

export async function getBaseFee(): Promise<number> {
  const r = await lcd<{ base_fee: string }>("/osmosis/txfees/v1beta1/cur_eip_base_fee");
  return Number(r.base_fee);
}

export type GammPool = {
  "@type": string;
  id: string;
  address: string;
  total_shares: Coin;
  pool_assets?: { token: Coin; weight: string }[];
  pool_liquidity?: Coin[];
};

export async function getPool(id: string): Promise<GammPool> {
  const r = await lcd<{ pool: GammPool }>(`/osmosis/poolmanager/v1beta1/pools/${id}`);
  return r.pool;
}

/** The pool's own record of its reserves (not its bank balance). */
export function poolRecord(pool: GammPool): Coin[] {
  if (pool.pool_assets) return pool.pool_assets.map((a) => a.token);
  if (pool.pool_liquidity) return pool.pool_liquidity;
  throw new Error("Not a GAMM (weighted or stableswap) pool");
}

export const explorerTx = (hash: string) => `https://www.mintscan.io/osmosis/tx/${hash}`;
export const explorerAccount = (addr: string) => `https://www.mintscan.io/osmosis/address/${addr}`;
