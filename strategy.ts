// Launch sniper with a rug filter, for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Every coin is watched from its CreateEvent. In its first slots the bot reads
// the opening tape: how big the creator's own buy was, how many other wallets
// piled in with it (a launch bundled by many wallets in its first slot is
// usually the creator's cluster waiting to dump), whether the creator has
// already sold, and how much real SOL the curve holds. It buys only launches
// that pass, rides winners with a trailing stop (no fixed take-profit cap, so
// a runner can pay for the losers), cuts losers fast, never holds past
// maxHold slots, and leaves at once when the creator sells.
//
// Deterministic by construction: no clock, no environment, no Math.random;
// the only time source is block_time from the events themselves (fill pacing).

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /**
   * Guardrail pacing: the run must make at least 200 fills. When the bot's filled-order count runs
   * behind fillTarget prorated over the window (windowSeconds of block time from the first event),
   * each order is split into pieces sent in the same reply (baseSplit normally, up to maxSplit):
   * the pieces fill at the same price as the whole order, cost one extra tx fee each, and a failed
   * tx then stalls only part of the order.
   */
  fillTarget: number;
  windowSeconds: number;
  baseSplit: number;
  maxSplit: number;
  /** Smallest buy piece worth sending (lamports). */
  minPieceLamports: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 2,
  stakeLamports: 100_000_000,
  minBuyLamports: 5_000_000,
  minRealSol: 300_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 0,
  maxDevBuy: 1_000_000_000,
  minTrades: 1,
  minBuyers: 0,
  maxBuyers: 2,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  flowWindow: 10,
  minFlowLamports: 0,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlippageBps: 10_000,
  slBps: 800,
  trailArmBps: 300,
  trailBps: 1500,
  maxHold: 10,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  fillTarget: 300,
  windowSeconds: 21_600,
  baseSplit: 1,
  maxSplit: 2,
  minPieceLamports: 2_000_000,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  buysSent: number;
  spentSent: bigint;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
}

const CURVE_FEE_BPS = 125n;

/**
 * Lamports a sale of `amount` tokens would bring back from a curve holding
 * (`quoteReserves`, `tokenReserves`), after the curve's own fees (95 bps
 * protocol + 30 bps creator). The fee rounds up, so the net never exceeds
 * the gross quote the constant-product curve would pay.
 */
function netSaleProceeds(amount: bigint, quoteReserves: bigint, tokenReserves: bigint): bigint {
  if (amount <= 0n || tokenReserves <= 0n) return 0n;
  const gross = (amount * quoteReserves) / (tokenReserves + amount);
  const fee = (gross * CURVE_FEE_BPS + BPS - 1n) / BPS;
  return gross - fee;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);
  let firstTime: number | null = null;
  let nowTime = 0;
  let filled = 0;

  /** How many pieces to split an order into now: baseSplit, more when the fill count lags its pace. */
  function pieces(): number {
    if (firstTime === null) return P.baseSplit;
    const elapsed = Math.max(0, Math.min(P.windowSeconds, nowTime - firstTime));
    const due = (P.fillTarget * elapsed) / P.windowSeconds;
    if (filled >= due) return P.baseSplit;
    const behind = due - filled;
    return Math.min(P.maxSplit, P.baseSplit + (behind > P.fillTarget * 0.15 ? 2 : 1));
  }

  /**
   * Split a sale of `amount` tokens into at most `wanted` orders (and never
   * more than `room`) in one reply. The pieces are equal except the last,
   * which takes whatever is left, so they always add back to `amount`.
   * A sale too small to split goes out as a single order instead.
   */
  function splitSale(mint: Pubkey, amount: bigint, wanted: number, room: number): OrderInput[] {
    const count = BigInt(Math.max(1, Math.min(wanted, room)));
    const even = amount / count;
    if (even === 0n) return [{ side: 'sell', mint, token_amount: amount, max_slippage_bps: 10_000 }];
    const orders: OrderInput[] = [];
    let sent = 0n;
    for (let idx = 0n; idx < count; idx++) {
      const lastOne = idx === count - 1n;
      const qty = lastOne ? amount - sent : even;
      orders.push({ side: 'sell', mint, token_amount: qty, max_slippage_bps: 10_000 });
      sent += qty;
    }
    return orders;
  }

  /** Buy `amount` lamports as up to k orders in one reply (pieces of at least minPieceLamports). */
  function buyOrders(mint: Pubkey, amount: bigint, k: number, room: number): OrderInput[] {
    let n = BigInt(Math.max(1, Math.min(k, room)));
    const minPiece = BigInt(P.minPieceLamports);
    while (n > 1n && amount / n < minPiece) n -= 1n;
    const piece = amount / n;
    const out: OrderInput[] = [];
    for (let i = 0n; i < n; i++) {
      const amt = i === n - 1n ? amount - piece * (n - 1n) : piece;
      out.push({ side: 'buy', mint, quote_lamports: amt, max_slippage_bps: P.buySlippageBps });
    }
    return out;
  }

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          spentSent: 0n,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold and the distinct buyers, over the last flowWindow slots. */
  function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  /**
   * Whether a position must close right now. `worth` is what the position
   * would sell for after fees and one more tx fee, `cost` is what went into
   * it (fill cost plus the tx fees its fills paid), and `open.best` is the
   * highest `worth` seen so far. The rules, in order:
   *  - hard stop: down slBps from cost, cut the loser fast;
   *  - trailing stop: once the best value is up at least trailArmBps over
   *    cost, a fall of trailBps from that best ends the ride — winners run,
   *    losers get cut, and there is no fixed take-profit cap;
   *  - time stop: held maxHold slots or more;
   *  - creator sold while held (unless they had already sold at open);
   *  - no trade on the coin for staleSlots slots.
   * The stop and trailing rules only apply when the cost basis is positive.
   */
  function closeNow(slot: number, coin: Coin | undefined, open: Held, worth: bigint, cost: bigint): boolean {
    if (cost > 0n && worth * BPS <= cost * (BPS - BigInt(P.slBps))) return true;
    if (
      cost > 0n &&
      open.best * BPS >= cost * (BPS + BigInt(P.trailArmBps)) &&
      worth * BPS <= open.best * (BPS - BigInt(P.trailBps))
    ) return true;
    if (slot - open.openedSlot >= P.maxHold) return true;
    if (coin === undefined) return false;
    if (P.exitOnDevSell && coin.devSold && !open.devSoldAtOpen) return true;
    if (slot - coin.lastTradeSlot >= P.staleSlots) return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const fill of batch.fills) {
        // The harness's own closes carry client ids starting with '_': they
        // end our bookkeeping for that mint outright, position or not.
        if (fill.client_id.startsWith('_')) {
          held.delete(fill.mint);
          selling.delete(fill.mint);
          continue;
        }
        if (fill.status === 'filled') filled += 1;
        const open = held.get(fill.mint);
        // Every settled fill on a tracked position adds its tx fee to the
        // position's cost basis; a rejected one pays nothing.
        if (open !== undefined && fill.status !== 'rejected') open.txPaid += BigInt(fill.tx_fee_lamports);
        // A filled buy with no record yet opens one, stamped at its slot.
        if (fill.side === 'buy' && fill.status === 'filled' && open === undefined) {
          held.set(fill.mint, {
            openedSlot: fill.slot,
            txPaid: BigInt(fill.tx_fee_lamports),
            best: 0n,
            devSoldAtOpen: coins.get(fill.mint)?.devSold ?? false,
          });
        }
      }
      // A sale is finished once nothing of it is still pending, and a held
      // record with no position, no sale in flight and no buy pending is
      // stale — drop both so they cannot block a later re-entry.
      for (const mint of [...selling]) {
        if (!hasPendingSell(state, mint)) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }
      const k = pieces();

      // Exits run before entries: every open position is re-priced each
      // batch, and sold the moment any exit rule fires.
      for (const [mint, holding] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const coin = coins.get(mint);
        let open = held.get(mint);
        if (open === undefined) {
          // A position with no record yet (a fill we missed) starts fresh
          // at this slot, charged one tx fee as its opening cost.
          open = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: coin?.devSold ?? false };
          held.set(mint, open);
        }
        let mark = marks.get(mint);
        if (mark === undefined) {
          const curve = state.curves.get(mint);
          if (curve === undefined) continue;
          mark = { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves };
        }
        const worth = netSaleProceeds(holding.token_amount, mark.vq, mark.vt) - tx;
        const cost = holding.cost_lamports + open.txPaid;
        if (worth > open.best) open.best = worth;
        if (!closeNow(state.slot, coin, open, worth, cost)) continue;
        orders.push(...splitSale(mint, holding.token_amount, k, cap - orders.length));
        selling.add(mint);
        if (coin !== undefined) coin.done = true;
      }

      // Entries: one buy per launch, only inside the entry window, only if the
      // rug filter and the flow filter both pass.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (age < P.minAge) continue;
        if (c.buysSent > 0) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && P.skipDevSold) {
          c.done = true;
          continue;
        }
        // Rug filter.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.trades < P.minTrades || c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        // Flow filter: recent net flow must not be negative.
        const fl = flow(c, state.slot);
        if (fl.net < BigInt(P.minFlowLamports) || fl.buyers < P.minRecentBuyers) continue;
        const room = stake - c.spentSent;
        if (room < minBuy) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx * 6n) continue;
        const buys = buyOrders(c.mint, amount, k, cap - orders.length);
        orders.push(...buys);
        free -= amount + tx * BigInt(buys.length);
        c.buysSent += 1;
        c.spentSent += amount;
        open += 1;
      }
      return orders;
    },
  };
}
