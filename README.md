# Pump.fun Paper Sprint: Any Bot Can Win

![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)
![make.fun rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/jefriidan15/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-westi/rank.svg)
![make.fun reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/jefriidan15/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-westi/reward.svg)

A momentum trading bot for the pump.fun paper-trading replay
(`agent-fun/replay/v2`). It trades 10 SOL of paper money on a replay of real
pump.fun bonding-curve activity, ranked by net PnL.

## Strategy

- **Entry:** a curve becomes a buy when it is mature (past `minAge` slots
  since its CreateEvent) and its recent tape shows accelerating buy pressure:
  net SOL flowing in over the window, several distinct buyers, a rising price
  sitting near its window high, and more net inflow in the newer half of the
  window than in the older half. A single wallet dominating the window's buy
  SOL is skipped (bundled-launch / dump risk).
- **Sizing:** the first buy is small (`initialSol`); the position is then
  pyramided into strength only — each later batch adds `addSol` while the
  price is above the last buy's and net SOL still flows in — up to `stakeSol`.
  Buys respect the 1%-of-real-reserve size cap and the cash on hand.
- **Exits:** a position is sold whole on the first of a stop loss against
  cost, a trailing stop from its best close value, a fade in net flow, a
  single very large recorded sell, or a time limit.
- **Guardrails:** tiny probe round trips keep the run above 200 fills over 20
  distinct mints when the main entries are quiet; total exposure is capped
  well under the 50% max-drawdown guardrail. No shorts, no leverage; every
  order pays the protocol + creator fees the harness charges.

## Layout

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts` (Node 22+,
  type stripping, zero dependencies).
- `strategy.ts` — the momentum strategy (this entry's own code).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.

## Run

```sh
node main.ts
```

The bot speaks the replay protocol on stdin/stdout. It is deterministic: two
executions produce byte-identical action logs (no clock, no environment, no
`Math.random`; the only time source is `block_time` from the events).

## License

MIT — see `LICENSE`.
