// Pump.fun Paper Sprint: Any Bot Can Win — @westi7460 entry (momentum).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
// Strategy: accelerating buy pressure + pyramid into strength, exits on stop,
// trail, fade, big sell, or time. Probes keep the fill/coin guardrails met.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
