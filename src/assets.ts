const ASSET_LIST_URL =
  "https://raw.githubusercontent.com/osmosis-labs/assetlists/main/osmosis-1/generated/frontend/assetlist.json";

export type AssetInfo = { symbol: string; decimals: number; known: boolean };

let assets: Map<string, AssetInfo> | undefined;

export async function loadAssets(): Promise<void> {
  if (assets) return;
  const res = await fetch(ASSET_LIST_URL);
  const json: { assets: { coinMinimalDenom: string; symbol: string; decimals: number }[] } =
    await res.json();
  assets = new Map(
    json.assets.map((a) => [a.coinMinimalDenom, { symbol: a.symbol, decimals: a.decimals, known: true }])
  );
}

export function assetInfo(denom: string): AssetInfo {
  const pool = denom.match(/^gamm\/pool\/(\d+)$/);
  if (pool) return { symbol: `Pool ${pool[1]} shares`, decimals: 18, known: true };
  // Unlisted denoms are shown and entered in raw base units.
  return assets?.get(denom) ?? { symbol: shortDenom(denom), decimals: 0, known: false };
}

export function shortDenom(denom: string): string {
  return denom.length > 24 ? `${denom.slice(0, 14)}…${denom.slice(-6)}` : denom;
}

export function formatAmount(amount: bigint | string, decimals: number): string {
  const v = BigInt(amount);
  if (decimals === 0) return v.toLocaleString("en-US");
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toLocaleString("en-US");
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function formatCoin(amount: bigint | string, denom: string): string {
  const info = assetInfo(denom);
  return `${formatAmount(amount, info.decimals)} ${info.symbol}`;
}

/** Parses a human amount into base units without floating point. */
export function parseAmount(input: string, decimals: number): bigint {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Enter a positive number");
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}
