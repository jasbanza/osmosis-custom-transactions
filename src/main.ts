import "./style.css";
import { loadAssets } from "./assets";
import { explorerAccount, explorerTx } from "./chain";
import {
  checkFeeFunds,
  describeEvents,
  estimateFee,
  signAndBroadcast,
  simulate,
  waitForTx,
  type SimResult,
} from "./engine";
import { restoreExit } from "./txs/restore-exit";
import { sendTokens } from "./txs/send";
import type { BuiltTx, Ctx, TxBuilder } from "./txs/types";
import { $, esc } from "./ui";
import { connectKeplr, onKeplrAccountChange, type Wallet } from "./wallet";

const BUILDERS: TxBuilder[] = [sendTokens, restoreExit];

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header>
    <h1>Osmosis custom transactions</h1>
    <div id="wallet"><button id="connect">Connect Keplr</button></div>
  </header>
  <main>
    <label>Transaction
      <select id="tx-type">${BUILDERS.map((b) => `<option value="${b.id}">${esc(b.label)}</option>`).join("")}</select>
    </label>
    <aside id="tx-about" class="about"></aside>
    <form id="form" onsubmit="return false"><p class="muted">Connect Keplr to start.</p></form>
    <div class="actions">
      <button id="simulate" disabled>Simulate</button>
      <button id="sign" disabled>Sign &amp; broadcast</button>
    </div>
    <section id="summary"></section>
    <section id="result"></section>
  </main>
  <footer class="muted">
    Never share your seed phrase. Every transaction is simulated against the live chain before your wallet is asked to sign, and Keplr shows the exact messages before you approve.
    <a href="https://github.com/jasbanza/osmosis-custom-transactions" target="_blank" rel="noreferrer">Source</a>
  </footer>`;

const typeSel = $(app, "#tx-type") as HTMLSelectElement;
const form = $(app, "#form");
const simBtn = $(app, "#simulate") as HTMLButtonElement;
const signBtn = $(app, "#sign") as HTMLButtonElement;
const summary = $(app, "#summary");
const result = $(app, "#result");

let wallet: Wallet | undefined;
let builder = BUILDERS[0];
let simulated: { tx: BuiltTx; sim: SimResult } | undefined;

const params = new URLSearchParams(location.search);
const preset = BUILDERS.find((b) => b.id === params.get("tx"));
if (preset) {
  builder = preset;
  typeSel.value = preset.id;
}

const ctx = (): Ctx => ({ wallet: wallet!, invalidate });

function invalidate() {
  simulated = undefined;
  signBtn.disabled = true;
}

function renderForm() {
  invalidate();
  summary.innerHTML = "";
  result.innerHTML = "";
  $(app, "#tx-about").innerHTML = `
    <p>${esc(builder.description)}</p>
    <h2>When to use this</h2>
    ${list(builder.whenToUse)}`;
  if (!wallet) return;
  builder.render(form, ctx());
  simBtn.disabled = false;
  const pool = params.get("pool");
  const poolInput = form.querySelector<HTMLInputElement>("#re-pool");
  if (pool && poolInput) {
    poolInput.value = pool;
    form.querySelector<HTMLButtonElement>("#re-load")?.click();
  }
}

function log(html: string, cls = "") {
  result.insertAdjacentHTML("beforeend", `<p class="${cls}">${html}</p>`);
}

function list(lines: string[]) {
  return lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "";
}

async function connect() {
  try {
    await loadAssets();
    wallet = await connectKeplr();
    $(app, "#wallet").innerHTML = `
      <span>${esc(wallet.name)}${wallet.isLedger ? " (Ledger)" : ""}</span>
      <a href="${explorerAccount(wallet.address)}" target="_blank" rel="noreferrer"><code>${esc(wallet.address)}</code></a>`;
    renderForm();
  } catch (e) {
    $(app, "#wallet").insertAdjacentHTML("beforeend", `<p class="error">${esc((e as Error).message)}</p>`);
  }
}

$(app, "#connect").addEventListener("click", connect);
onKeplrAccountChange(() => wallet && connect());

typeSel.addEventListener("change", () => {
  builder = BUILDERS.find((b) => b.id === typeSel.value)!;
  renderForm();
});

simBtn.addEventListener("click", async () => {
  if (!wallet) return;
  invalidate();
  simBtn.disabled = true;
  summary.innerHTML = "";
  result.innerHTML = "";
  try {
    const tx = await builder.build(ctx());
    summary.innerHTML = `<h2>This transaction will</h2>${list(tx.summary)}`;
    log("Simulating against the live chain…");
    const sim = await simulate(wallet, tx);
    result.innerHTML = "";
    log(`Simulation passed. Estimated gas: ${sim.gasUsed.toLocaleString("en-US")}.`, "ok");
    result.insertAdjacentHTML("beforeend", list(describeEvents(sim.events, wallet.address)));
    simulated = { tx, sim };
    signBtn.disabled = false;
  } catch (e) {
    result.innerHTML = "";
    log(`Simulation failed: ${esc((e as Error).message)}`, "error");
  } finally {
    simBtn.disabled = false;
  }
});

signBtn.addEventListener("click", async () => {
  if (!wallet || !simulated) return;
  const { tx, sim } = simulated;
  signBtn.disabled = true;
  simBtn.disabled = true;
  try {
    const fee = await estimateFee(sim.gasUsed);
    await checkFeeFunds(wallet, tx, fee);
    log("Waiting for your approval in Keplr…");
    const hash = await signAndBroadcast(wallet, tx, fee);
    log(`Broadcast. Tx hash: <a href="${explorerTx(hash)}" target="_blank" rel="noreferrer"><code>${hash}</code></a>`);
    log("Waiting for the transaction to land on chain…");
    const landed = await waitForTx(hash);
    if (!landed) {
      log("Not seen on chain within 90 seconds. Check the explorer link before trying again.", "error");
    } else if (landed.code !== 0) {
      log(`Included in block ${landed.height} but FAILED (code ${landed.code}): ${esc(landed.rawLog)}`, "error");
    } else {
      log(`Landed in block ${landed.height}. Success.`, "ok");
      result.insertAdjacentHTML("beforeend", list(describeEvents(landed.events, wallet.address)));
      if (builder.verify) {
        log("Checking the result on chain:");
        result.insertAdjacentHTML("beforeend", list(await builder.verify(ctx())));
      }
    }
    invalidate();
  } catch (e) {
    log(esc((e as Error).message), "error");
    signBtn.disabled = false;
  } finally {
    simBtn.disabled = false;
  }
});

renderForm();
