# robinhood-market-making-tools

A TypeScript SDK for market making on **Robinhood Chain** (mainnet and testnet).

- Trade any ERC-20 pair on Uniswap V2, V3 and V4: ETH/WETH, USDG, tokenized stocks, or anything else with a pool.
- Uniswap V4 is supported natively, including native-ETH pools and pools with hooks. Quotes come from simulating the real swap.
- Transactions are signed before they're broadcast and never re-sent at a new nonce, so a retry can't turn one trade into two. An outcome that can't be confirmed is reported as `unknown`, never guessed.
- Risk limits apply to every strategy: a spend cap, a drawdown limit and a liquidity floor. Paper mode simulates trades without signing.
- Seven composable strategies are built in, and custom ones plug into the same runner.
- The only dependency is `viem`. The SDK reads no environment variables, no files and no global state, so it runs the same in Node, serverless functions and bundlers.

No fees, no telemetry, MIT licensed.

> **Status: 0.x and unaudited.** The API may change between minor versions. Start with `readOnly: true`, then testnet, then small amounts on mainnet.
>
> Independent open-source project, not affiliated with, endorsed by, or operated by Robinhood Markets, Inc. or Uniswap Labs. Nothing here is financial advice. You are responsible for the trades your keys sign.

---

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [Trading directly](#trading-directly)
- [Running strategies](#running-strategies)
- [Built-in strategies](#built-in-strategies)
- [Risk limits and paper mode](#risk-limits-and-paper-mode)
- [Trade outcomes](#trade-outcomes-filled-failed-unknown)
- [Trading policy](#trading-policy)
- [Writing a strategy](#writing-a-strategy)
- [Networks and DEXes](#networks-and-dexes)
- [Errors](#errors)
- [Limitations](#limitations)
- [Handling keys](#handling-keys)
- [Architecture](#architecture)
- [Development](#development)

## Install

The package isn't on the npm registry yet. Install it from GitHub; it builds itself on install:

```sh
npm install github:devjoinedthechat/robinhood-market-making-tools viem
```

Requires Node 20.10 or later. Ships ESM and CommonJS, with type declarations.

## Quick start

### 1. Read a market (no wallet needed)

```ts
import { createMarketMaker, robinhood } from 'robinhood-market-making-tools';

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const mm = createMarketMaker({ chain: robinhood, readOnly: true });

// WETH/USDG 0.05% on Uniswap V3, priced in USDG.
const market = await mm.market('0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a', { quote: USDG });

console.log(await market.price());         // ETH price in USDG
console.log(await market.quoteBuy('100')); // what 100 USDG buys, with price impact
```

### 2. Run a strategy

```ts
import { createMarketMaker, robinhoodTestnet, walletFromPrivateKey, gridStrategy } from 'robinhood-market-making-tools';

const mm = createMarketMaker({ chain: robinhoodTestnet });

// A pool address (V2/V3), a 64-character PoolId (V4), or a V4 PoolKey.
const market = await mm.market('0x9640AFcBc2310d011B7b71a76975e919D9B6Fa4A');
console.log(market.info.token.symbol, 'priced in', market.info.quote.symbol, '@', await market.price());

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

const result = await mm.run({
  market,
  wallets: [walletFromPrivateKey(process.env.PRIVATE_KEY!)],
  strategies: gridStrategy({ stepPercent: 1, levels: 5, orderSize: 0.001 }),
  risk: { maxSpend: 0.05, maxDrawdown: 0.01 },
  paper: true, // simulate first; remove to trade
  signal: controller.signal,
  onEvent: (e) => e.type === 'trade' && console.log(e.result),
});

console.log(result.status, result.trades, result.ledger.netPnl);
```

A complete runnable version is in [`examples/grid-testnet.ts`](examples/grid-testnet.ts):

```sh
git clone https://github.com/devjoinedthechat/robinhood-market-making-tools && cd robinhood-market-making-tools
npm install
PRIVATE_KEY=0x… POOL=0x… PAPER=1 node examples/grid-testnet.ts   # Node 22.18+ runs the TypeScript directly
```

## Concepts

| Concept | What it is |
| --- | --- |
| **`MarketMaker`** | Entry point. Holds the chain client, the DEX registry, the trading policy and the wallet locks. |
| **`Market`** | One pool with a traded **token** and a **quote** asset. It quotes, trades, reads balances and watches other traders' swaps. |
| **`Wallet`** | A viem `LocalAccount` plus a label. It never carries its private key, so it is safe to log. |
| **`Fleet`** | The wallets a run trades with. Strategies ask it for a wallet that can fund a buy, or for the largest token holder. |
| **`Strategy`** | A value `{ name, validate?, run(ctx) }`, built by a factory that validates its parameters. |
| **`GuardedMarket`** | Wraps a market with risk limits and paper mode. Every strategy in a run shares one. |

### Which side is the quote?

`mm.market(pool)` treats ETH/WETH as the quote, then any token in `chain.knownQuoteTokens` (USDG, VIRTUAL and so on). If neither side is recognised, it logs a warning and follows a convention. Pass `quote` explicitly whenever it matters:

```ts
const nvda = await mm.market(nvdaUsdgPool, { quote: USDG }); // token NVDA, priced in USDG
```

If the quote is WETH on V2/V3, or native ETH on V4, buys spend ETH and sells return ETH (`market.info.settlesInNative`). For any other quote, including USDG and tokenized stocks, buys spend that ERC-20 and approvals are handled for you.

## Trading directly

```ts
const preview = await market.quoteBuy('0.01');            // spend 0.01 quote
// { amountOut, minAmountOut, priceImpact, price, rejection }

const bought = await market.buy({ wallet, amount: '0.01', slippagePct: 2 });
const sold = await market.sell({ wallet, amount: 'all' }); // exact balance, no float rounding
```

Amounts are human units, as a `number` or a decimal string. Prefer strings for exactness. Buy amounts are in the **quote** asset, sell amounts in the **token**.

Find pools for a token:

```ts
const pools = await mm.findPools(tokenAddress);          // vs WETH and native ETH, deepest first
const usdgPools = await mm.findPools(tokenAddress, USDG);
```

Watch other traders:

```ts
const feed = market.tradeFeed({ side: 'sell', exclude: myAddresses, minQuote: 0.01 });
const sells = await feed.poll(); // new swaps since the last poll, each delivered once
```

## Running strategies

```ts
const result = await mm.run({
  market,
  wallets,
  strategies: [gridStrategy({ stepPercent: 0.5 }), inventoryRebalanceStrategy({ targetPercent: 50 })],
  risk: { maxSpend: 1, maxDrawdown: 0.1, liquidityFloorPct: 50 },
  paper: false,
  signal,
  onEvent,
  onStrategyError: 'stop-run', // or 'continue'
});
```

1. **Validate.** Every strategy checks it can start: funded wallets, inventory, an observable trade feed. A strategy that can't start throws `StrategyNotReadyError` before any trade.
2. **Lock.** The run locks every wallet. A second run on the same `MarketMaker` that overlaps any of them throws `WalletsBusyError`, because two runs sharing a wallet race each other for nonces.
3. **Run.** Strategies run concurrently and share one market, fleet and set of risk limits.
4. **Classify.** The run resolves to a `RunResult` with one of these statuses:

| `status` | Meaning |
| --- | --- |
| `completed` | Every strategy reached its own end, for example a finished TWAP. |
| `stopped` | You aborted `signal`. |
| `halted` | A risk limit tripped. `result.halt` names it. Every strategy stops. |
| `failed` | A strategy threw. See `result.strategies[].error`. By default its siblings stop too. |

Events arrive through `onEvent`: `started`, `trade` (with the strategy's label), `strategy-finished`, `halted` and `finished`.

## Built-in strategies

Amounts are human units, "quote" means the market's quote asset, and intervals are milliseconds. Every strategy also accepts `slippagePct`.

| Factory | Behaviour | Key parameters (defaults) |
| --- | --- | --- |
| `gridStrategy` | Ladder of rungs around a mid price. Buys when price crosses a rung downward and sells when it crosses one upward, once per crossing. Quoting stops past the last rung. | `mid` (spot), `stepPercent` 1, `levels` 5, `orderSize` 0.005 quote, `checkIntervalMs` 5000 |
| `inventoryRebalanceStrategy` | Holds book value near a token/quote split. Acts only when drift leaves the dead band, and corrects to the target. | `targetPercent` 50, `bandPercent` 5, `maxTradeQuote` (whole drift), `checkIntervalMs` 30000 |
| `twapStrategy` | Works a size in slices over a duration with ±10% timing jitter. Stops short, and reports `shortBy`, when a slice can't be funded. | `side`, `total` (required; quote to buy or tokens to sell), `slices` 10, `durationMs` 1h |
| `supportBuyStrategy` | Fixed-size buy each time price breaks below a level. Re-arms only after the level is reclaimed by a band. Ends at the cap. | `level` (spot −2%), `amount` 0.01 quote, `rearmPercent` 0.5, `maxBuys` 10 |
| `takeProfitStrategy` | The mirror image: sells into strength above a level, once per breach. | `level` (spot +2%), `percentOfHolding` 25 or `amount` in tokens, `rearmPercent` 0.5, `maxSells` 10 |
| `dipBuyStrategy` | Buys back a share of **external** sell volume. The fleet's own sells are excluded. Capped per event. | `buybackPercent` 30, `minSellQuote` 0.0003, `maxBuyQuote` 0.015, `checkIntervalMs` 5000 |
| `absorbWallStrategy` | Answers a single external sell that is large **relative to pool depth**. The response grows with √severity, is capped per wall and has a cooldown. | `wallPoolPercent` 2, `responsePercent` 50, `maxPerWall` 0.02 quote, `cooldownMs` 60000, `maxWalls` 10 |

The same factories are also collected in one object for discovery: `strategies.grid(...)`, `strategies.twap(...)` and so on.

## Risk limits and paper mode

Limits live in a `GuardedMarket` that wraps the market every strategy trades through. They bind all strategies in a run, including custom ones, and siblings share one budget.

| Limit | Behaviour |
| --- | --- |
| `maxSpend` | Most quote buys may commit. The commitment is made **before** sending. It is released if a buy fails, and kept if the outcome is unknown, so in-flight trades can't slip past the cap. |
| `maxDrawdown` | Halts once `quoteReceived + inventory × lastFillPrice − quoteSpent` is below `−maxDrawdown`. Marked from the run's own fills. Excludes gas. |
| `liquidityFloorPct` | Halts when quote-side pool depth falls below this percentage of its high-water mark, since a draining pool looks like a falling price. **Defaults to 50** in `run`; set `0` to disable. |

Limits are checked before **buys** only. A sell is never blocked, because the exit must stay open.

`paper: true` fills at spot price without signing anything. It doesn't model price impact or fees, so it tells you whether a strategy behaves as expected, not what it would earn.

For verification without any risk, create the client with `readOnly: true`. Reads, quotes and simulations work, and any broadcast throws `BroadcastBlockedError`.

## Trade outcomes: filled, failed, unknown

```ts
type TradeResult =
  | { status: 'filled'; side; wallet; quoteAmount; tokenAmount; price; hash?; block?; feeNative?; paper? }
  | { status: 'failed'; side; wallet; error; hash? }
  | { status: 'unknown'; side; wallet; error; hash? };
```

- **`filled`**: amounts come from the receipt (Transfer logs, or the DEX's Swap event for native-ETH legs), not from the pre-trade quote.
- **`failed`**: nothing was spent, or the transaction reverted. It is safe to try again.
- **`unknown`**: the transaction was broadcast and its outcome couldn't be established. **It may still land. Do not retry it.** Check the hash, and resolve the wallet's nonce before trading that wallet again.

The executor enforces this. It signs before broadcasting and records every hash. A retry re-sends the identical bytes, or replaces them at the same nonce with higher fees. It never re-sends at a new nonce.

## Trading policy

```ts
createMarketMaker({
  chain: robinhood,
  trading: {
    defaultSlippagePct: 5,
    maxBuySlippagePct: 15,   // a higher requested slippage is refused, not clamped
    maxSellSlippagePct: 50,
    maxPriceImpactPct: 10,   // trades quoting more impact are refused before sending
    deadlineSeconds: 195,
  },
});
```

## Writing a strategy

```ts
import { assertParams, check, noteResult, readPrice, type Strategy } from 'robinhood-market-making-tools';

export function meanReversion(params: { band: number; size: number }): Strategy {
  assertParams('mean-reversion', [check.positive('band', params.band), check.positive('size', params.size)]);
  return {
    name: 'mean-reversion',
    description: 'Buy below the moving average',
    async run(ctx) {
      const prices: number[] = [];
      while (!ctx.signal.aborted) {
        const price = await readPrice(ctx);          // undefined on a failed read; the loop retries
        if (price !== undefined) {
          prices.push(price);
          const recent = prices.slice(-20);
          const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
          if (price < avg * (1 - params.band)) {
            const buyer = await ctx.fleet.findBuyer(params.size);
            if (buyer) noteResult(ctx, 'buy', await ctx.market.buy({ wallet: buyer.wallet, amount: params.size }));
          }
        }
        await ctx.sleep(5_000);                      // abort-aware; never use a bare timer
      }
    },
  };
}
```

The rules:
- Put per-run state inside `run`.
- Loop on `ctx.signal`.
- Sleep with `ctx.sleep`.
- Don't catch `RiskLimitError`, because that is how a limit stops the run.

Strategies depend only on the `TradingMarket` interface, so you can unit-test them against an in-memory fake. See [`test/fakes.ts`](test/fakes.ts).

## Networks and DEXes

| Network | Chain ID | DEXes |
| --- | --- | --- |
| `robinhood` | 4663 | Uniswap V2, Uniswap V3, Uniswap V4 |
| `robinhoodTestnet` | 46630 | Synthra V3, Uniswap V4 |

Other things to know:
- **RPC endpoints.** The public endpoints are the defaults. For anything long-running, pass your own with `rpcUrls` (best first; reads fail over down the list), or pass a viem `transport`.
- **V4 pool lookup.** Name a V4 pool by its PoolKey to skip the log lookup for its key. Hooked V4 pools can't be discovered by pair and must be named by PoolId or PoolKey.
- **V4 quoting.** V4 quotes simulate the swap inside the PoolManager, with a quoter injected by `eth_call` state override. Nothing is deployed. The quoter source is [`contracts/V4Quoter.sol`](contracts/V4Quoter.sol), and its embedded bytecode is reproducible (see [Development](#development)).
- **MEV.** Robinhood Chain is an Arbitrum Orbit L2 with a sequencer and no public mempool, so there is no front-running to route around and no private-transaction option.

## Errors

Every intentional error extends `MarketMakerError` and carries a stable `code`.

| Error | When |
| --- | --- |
| `ConfigError` | Invalid input. Thrown before anything touches the chain. |
| `ReadError` | An RPC read failed. A failed read is never reported as zero. |
| `PoolNotFoundError` | No configured DEX has an initialised pool for the reference. |
| `StrategyNotReadyError` | A strategy's `validate` refused to start. |
| `WalletsBusyError` | Another run on this `MarketMaker` holds one of the wallets. |
| `RiskLimitError` | A limit tripped (`limit`: `spend-cap`, `drawdown` or `liquidity-floor`). Surfaces as `status: 'halted'`. |
| `BroadcastBlockedError` | A `readOnly` client tried to send. |

## Limitations

- **Robinhood Chain only.** Mainnet and testnet; no other networks.
- **Hooked V4 pools** must be named by PoolId or PoolKey, because `findPools` only discovers hookless pools. A hook that rejects simulated swaps can't be quoted.
- **Paper mode** prices fills at spot, with no price impact, fees or gas.
- **Wallet locks** are per `MarketMaker` instance, in one process. Two processes trading the same keys will race for nonces.
- **The run ledger and drawdown limit** count only this run's own fills, and exclude gas.
- **Gas-worthiness checks** only work when the quote is ETH or WETH. With any other quote (USDG, stock tokens) every positive trade passes.
- **Trade feeds on busy pools** can take several seconds on the first poll, because each swap's sender is looked up. Later polls cover only new blocks.

## Handling keys

- A `Wallet` never holds its private key, and the SDK never logs, stores or transmits keys.
- Load keys at the edge of your application, from a secrets manager or the environment, never from source code.
- To keep raw keys out of the process entirely, wrap a remote signer (for example a KMS) as a viem `LocalAccount` with `toAccount`, then pass it to `walletFromAccount`.
- Give each bot its own wallets, and fund them with only what its `maxSpend` allows.

## Architecture

Each layer depends only on the layers below it. `test/architecture.test.ts` enforces this, along with the rule that `src/` never touches the environment, the filesystem or the console.

```
MarketMaker                     front door
strategy/  Fleet, strategies, runner
risk/      GuardedMarket        spend cap · drawdown · liquidity floor · paper
market/    Market, trade feeds, resolution   policy · approvals · fill accounting
dex/       V2 · V3 · V4 connectors, registry  pool reads · quotes · calldata
client/    ChainClient, TransactionExecutor   balances · safe execution
chains · units · wallet · errors · logger    data and primitives
```

## Development

Development requires Node 22.18 or later, because tests and scripts run TypeScript directly.

```sh
npm install              # also builds dist/
npm run check            # typecheck, tests and build
npm test                 # node:test, no network
npm run smoke            # read-only checks against live mainnet and testnet
```

`npm run smoke` never signs. It proves swap calldata by `eth_call`, using a state override to fund a throwaway address. Each simulated swap must return at least 99% of the SDK's own quote, which checks the encoding and the quote accuracy together.

To confirm the embedded V4 quoter matches its Solidity source:

```sh
npm install --no-save solc@0.8.28
node scripts/build-quoter.mjs --check
```

Issues and pull requests are welcome. Run `npm run check` before opening a pull request, and add tests for any change to execution, fill accounting or risk limits.

## License

MIT
