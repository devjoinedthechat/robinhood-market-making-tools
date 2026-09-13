/**
 * A Market is one pool, one traded token and one quote asset, bound together.
 *
 * It owns trading policy (slippage, impact limits, deadlines), approvals and
 * fill accounting. Results report what the receipt says happened — the fill,
 * not the pre-trade quote — because anything inside the slippage bound can
 * legitimately arrive, and recording the estimate drifts inventory and PnL in a
 * direction that always flatters the bot.
 */

import { decodeEventLog, getAddress, toEventSelector, type Address, type Hex, type Log } from 'viem';
import type { ChainClient } from '../client/chain-client.ts';
import { ERC20_ABI } from '../client/abis.ts';
import { ensureAllowance, ensurePermit2Allowance } from '../client/erc20.ts';
import { describeError, type ExecResult } from '../client/executor.ts';
import { poolDepth, type DexConnector, type DexQuote, type PoolState, type SwapCall } from '../dex/types.ts';
import { BroadcastBlockedError, ConfigError, ReadError } from '../errors.ts';
import { isZeroAddress, sameAddress } from '../internal/address.ts';
import { applySlippage, formatAmount, parseAmount, type Amount } from '../units.ts';
import type { Wallet } from '../wallet.ts';
import { PoolTradeFeed } from './trade-feed.ts';
import type {
  BuyOrder,
  MarketInfo,
  PoolSnapshot,
  SellOrder,
  TokenInfo,
  TradeFeed,
  TradeFeedOptions,
  TradeQuote,
  TradeResult,
  TradeSide,
  TradingMarket,
  TradingPolicy,
} from './types.ts';

const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)');

interface Transfer {
  readonly token: Address;
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
}

function parseTransfers(logs: readonly Log[]): Transfer[] {
  const out: Transfer[] = [];
  for (const entry of logs) {
    if (entry.topics[0] !== TRANSFER_TOPIC || entry.topics.length !== 3) continue;
    try {
      const { args } = decodeEventLog({ abi: ERC20_ABI, eventName: 'Transfer', data: entry.data, topics: entry.topics });
      out.push({ token: getAddress(entry.address), from: args.from, to: args.to, value: args.value });
    } catch {
      // same topic, different shape
    }
  }
  return out;
}

function sumTransfers(transfers: readonly Transfer[], token: Address, match: (t: Transfer) => boolean): bigint {
  return transfers.reduce((sum, t) => (sameAddress(t.token, token) && match(t) ? sum + t.value : sum), 0n);
}

export interface MarketDeps {
  readonly client: ChainClient;
  readonly connector: DexConnector;
  readonly pool: PoolState;
  readonly token: TokenInfo;
  readonly quote: TokenInfo;
  readonly policy: TradingPolicy;
}

export class Market implements TradingMarket {
  readonly info: MarketInfo;
  readonly policy: TradingPolicy;
  private readonly client: ChainClient;
  private readonly connector: DexConnector;
  private readonly initial: PoolState;
  /** V2/V3 only: the router wraps/unwraps ETH. V4 decides by the pool's own currency. */
  private readonly routerWrapsNative: boolean;

  constructor(deps: MarketDeps) {
    this.client = deps.client;
    this.connector = deps.connector;
    this.initial = deps.pool;
    this.policy = deps.policy;
    const { chain } = deps.client;
    const quote = deps.quote.address;
    const quoteIsWeth = sameAddress(quote, chain.wrappedNative);
    this.routerWrapsNative = deps.pool.kind !== 'v4' && quoteIsWeth;
    this.info = {
      chain: {
        id: chain.id,
        chainId: chain.chainId,
        testnet: chain.testnet,
        nativeSymbol: chain.nativeSymbol,
        feeHeadroom: chain.feeHeadroom,
        estimatedSwapFee: chain.estimatedSwapFee,
      },
      dex: deps.connector.id,
      dexKind: deps.pool.kind,
      pool: deps.pool.id,
      token: deps.token,
      quote: deps.quote,
      settlesInNative: this.routerWrapsNative || isZeroAddress(quote),
      quoteIsEth: quoteIsWeth || isZeroAddress(quote),
      feeBps: deps.pool.feeBps,
    };
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async snapshot(): Promise<PoolSnapshot> {
    return this.describe(await this.fresh());
  }

  async price(): Promise<number> {
    return (await this.snapshot()).price;
  }

  quoteBuy(amount: Amount, slippagePct?: number): Promise<TradeQuote> {
    return this.preview('buy', amount, slippagePct);
  }

  quoteSell(amount: Amount, slippagePct?: number): Promise<TradeQuote> {
    return this.preview('sell', amount, slippagePct);
  }

  tokenBalances(addresses: readonly string[]): Promise<number[]> {
    return this.client.tokenBalances(this.info.token.address, addresses);
  }

  quoteBalances(addresses: readonly string[]): Promise<number[]> {
    return this.info.settlesInNative
      ? this.client.nativeBalances(addresses)
      : this.client.tokenBalances(this.info.quote.address, addresses);
  }

  nativeBalances(addresses: readonly string[]): Promise<number[]> {
    return this.client.nativeBalances(addresses);
  }

  blockNumber(): Promise<number> {
    return this.client.blockNumber();
  }

  tradeFeed(options: TradeFeedOptions): TradeFeed {
    return new PoolTradeFeed(
      { client: this.client, connector: this.connector, pool: this.initial, token: this.info.token, maxLogRange: this.policy.maxLogRange },
      options,
    );
  }

  // ── trading ──────────────────────────────────────────────────────────────

  async buy(order: BuyOrder): Promise<TradeResult> {
    const side: TradeSide = 'buy';
    const { wallet } = order;
    const slippage = this.slippageFor(side, order.slippagePct);
    const amountIn = parseAmount(order.amount, this.info.quote.decimals);
    const token = this.info.token.address;
    const quote = this.info.quote.address;

    try {
      if (amountIn <= 0n) return this.failed(side, wallet, `Amount ${order.amount} rounds below one unit of the quote asset`);
      const pool = await this.fresh();
      if (!this.connector.isTradable(pool)) return this.failed(side, wallet, 'Pool is not initialised');

      const q = await this.connector.quote(pool, { tokenIn: quote, tokenOut: token, amountIn });
      const rejection = this.rejectionFor(q);
      if (rejection) return this.failed(side, wallet, rejection);

      const call = this.connector.buildSwap({
        pool,
        recipient: wallet.address,
        tokenIn: quote,
        tokenOut: token,
        amountIn,
        minAmountOut: applySlippage(q.amountOut, slippage),
        nativeIn: this.routerWrapsNative,
        nativeOut: false,
        deadline: this.deadline(),
      });
      const blocked = await this.approve(side, wallet, quote, call, amountIn);
      if (blocked) return blocked;

      const exec = await this.client.executor.execute(wallet, { to: call.to, data: call.data, value: call.value });
      if (exec.status !== 'confirmed') return this.fromExec(side, wallet, exec);

      const transfers = parseTransfers(exec.logs);
      const owner = wallet.address;
      let tokenRaw =
        sumTransfers(transfers, token, (t) => sameAddress(t.to, owner)) ||
        sumTransfers(transfers, token, (t) => sameAddress(t.from, pool.address));
      if (tokenRaw === 0n) tokenRaw = this.fillFromSwapLogs(pool, exec.logs)?.tokenOut ?? 0n;
      if (tokenRaw === 0n) {
        this.client.logger.warn('Could not read the fill from the receipt; reporting the quote', { hash: exec.hash });
        tokenRaw = q.amountOut;
      }
      const quoteRaw = this.info.settlesInNative
        ? amountIn
        : sumTransfers(transfers, quote, (t) => sameAddress(t.from, owner)) || amountIn;

      return this.filled(side, wallet, exec, formatAmount(quoteRaw, this.info.quote.decimals), formatAmount(tokenRaw, this.info.token.decimals));
    } catch (error) {
      if (error instanceof BroadcastBlockedError) throw error;
      return this.failed(side, wallet, describeError(error));
    }
  }

  async sell(order: SellOrder): Promise<TradeResult> {
    const side: TradeSide = 'sell';
    const { wallet } = order;
    const slippage = this.slippageFor(side, order.slippagePct);
    const requested = order.amount === 'all' ? undefined : parseAmount(order.amount, this.info.token.decimals);
    const floor = order.minQuoteOut === undefined ? undefined : parseAmount(order.minQuoteOut, this.info.quote.decimals);
    const token = this.info.token.address;
    const quote = this.info.quote.address;

    try {
      if (requested !== undefined && requested <= 0n) {
        return this.failed(side, wallet, `Amount ${String(order.amount)} rounds below one unit of the token`);
      }
      const pool = await this.fresh();
      if (!this.connector.isTradable(pool)) return this.failed(side, wallet, 'Pool is not initialised');

      const balance = await this.client.tokenBalanceRaw(token, wallet.address);
      if (balance <= 0n) return this.failed(side, wallet, 'Nothing to sell (zero balance)');

      // Approvals can mine two transactions and take tens of seconds, so they go
      // FIRST, and the balance and quote are read again right before the swap.
      const probe = this.connector.buildSwap({
        pool,
        recipient: wallet.address,
        tokenIn: token,
        tokenOut: quote,
        amountIn: requested !== undefined && requested < balance ? requested : balance,
        minAmountOut: 1n,
        nativeIn: false,
        nativeOut: this.routerWrapsNative,
        deadline: this.deadline(),
      });
      const blocked = await this.approve(side, wallet, token, probe, balance);
      if (blocked) return blocked;

      const current = await this.client.tokenBalanceRaw(token, wallet.address);
      const amountIn = requested === undefined || requested > current ? current : requested;
      if (amountIn <= 0n) return this.failed(side, wallet, 'Nothing to sell (zero balance)');

      const q = await this.connector.quote(pool, { tokenIn: token, tokenOut: quote, amountIn });
      const rejection = this.rejectionFor(q);
      if (rejection) return this.failed(side, wallet, rejection);

      const call = this.connector.buildSwap({
        pool,
        recipient: wallet.address,
        tokenIn: token,
        tokenOut: quote,
        amountIn,
        minAmountOut: floor !== undefined && floor > 0n ? floor : applySlippage(q.amountOut, slippage),
        nativeIn: false,
        nativeOut: this.routerWrapsNative,
        deadline: this.deadline(),
      });
      const exec = await this.client.executor.execute(wallet, { to: call.to, data: call.data, value: call.value });
      if (exec.status !== 'confirmed') return this.fromExec(side, wallet, exec);

      const transfers = parseTransfers(exec.logs);
      const owner = wallet.address;
      // A native-out V2/V3 sell pays WETH to the router, which unwraps it 1:1.
      let quoteRaw = this.routerWrapsNative
        ? sumTransfers(transfers, quote, (t) => sameAddress(t.from, pool.address))
        : sumTransfers(transfers, quote, (t) => sameAddress(t.to, owner));
      // A native-quoted V4 pool emits no Transfer for the ETH leg; its Swap event has both.
      if (quoteRaw === 0n) quoteRaw = this.fillFromSwapLogs(pool, exec.logs)?.quoteOut ?? 0n;
      if (quoteRaw === 0n) {
        this.client.logger.warn('Could not read the fill from the receipt; reporting the quote', { hash: exec.hash });
        quoteRaw = q.amountOut;
      }
      const tokenRaw = sumTransfers(transfers, token, (t) => sameAddress(t.from, owner)) || amountIn;

      return this.filled(side, wallet, exec, formatAmount(quoteRaw, this.info.quote.decimals), formatAmount(tokenRaw, this.info.token.decimals));
    } catch (error) {
      if (error instanceof BroadcastBlockedError) throw error;
      return this.failed(side, wallet, describeError(error));
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async fresh(): Promise<PoolState> {
    let pool: PoolState | null;
    try {
      pool = await this.connector.getPool(this.initial.id);
    } catch (error) {
      throw error instanceof ReadError ? error : new ReadError(`Could not read pool ${this.initial.id}: ${describeError(error)}`, { cause: error });
    }
    if (!pool) throw new ReadError(`Could not read pool ${this.initial.id}`);
    return pool;
  }

  private describe(pool: PoolState): PoolSnapshot {
    const tokenIs0 = sameAddress(pool.token0, this.info.token.address);
    const { depth0, depth1 } = poolDepth(pool);
    return {
      price: tokenIs0 ? pool.price0In1 : pool.price0In1 > 0 ? 1 / pool.price0In1 : 0,
      tokenReserve: formatAmount(tokenIs0 ? depth0 : depth1, this.info.token.decimals),
      quoteReserve: formatAmount(tokenIs0 ? depth1 : depth0, this.info.quote.decimals),
      fetchedAt: pool.fetchedAt,
    };
  }

  private async preview(side: TradeSide, amount: Amount, slippagePct: number | undefined): Promise<TradeQuote> {
    const slippage = this.slippageFor(side, slippagePct);
    const [inInfo, outInfo] = side === 'buy' ? [this.info.quote, this.info.token] : [this.info.token, this.info.quote];
    const amountIn = parseAmount(amount, inInfo.decimals);
    const pool = await this.fresh();
    const q = await this.connector.quote(pool, { tokenIn: inInfo.address, tokenOut: outInfo.address, amountIn });
    const amountInHuman = formatAmount(amountIn, inInfo.decimals);
    const amountOutHuman = formatAmount(q.amountOut, outInfo.decimals);
    const quoteSide = side === 'buy' ? amountInHuman : amountOutHuman;
    const tokenSide = side === 'buy' ? amountOutHuman : amountInHuman;
    return {
      side,
      amountIn: amountInHuman,
      amountOut: amountOutHuman,
      minAmountOut: formatAmount(q.amountOut > 0n ? applySlippage(q.amountOut, slippage) : 0n, outInfo.decimals),
      priceImpact: q.priceImpact,
      price: tokenSide > 0 ? quoteSide / tokenSide : 0,
      slippagePct: slippage,
      rejection: amountIn <= 0n ? 'Amount rounds to zero' : this.rejectionFor(q),
    };
  }

  private slippageFor(side: TradeSide, requested: number | undefined): number {
    const pct = requested ?? this.policy.defaultSlippagePct;
    if (!Number.isFinite(pct) || pct < 0) throw new ConfigError(`Slippage must be a non-negative number, got ${pct}`);
    const cap = side === 'buy' ? this.policy.maxBuySlippagePct : this.policy.maxSellSlippagePct;
    if (pct > cap) {
      const key = side === 'buy' ? 'maxBuySlippagePct' : 'maxSellSlippagePct';
      throw new ConfigError(`${side} slippage ${pct}% exceeds the ${cap}% cap; raise trading.${key} to allow it`);
    }
    return pct;
  }

  private rejectionFor(q: DexQuote): string | undefined {
    if (q.insufficientLiquidity || q.amountOut <= 0n) return 'Insufficient liquidity';
    const impactPct = q.priceImpact * 100;
    if (Number.isFinite(impactPct) && impactPct > this.policy.maxPriceImpactPct) {
      return `Price impact ${impactPct.toFixed(2)}% exceeds the ${this.policy.maxPriceImpactPct}% limit — trade smaller, or raise trading.maxPriceImpactPct`;
    }
    return undefined;
  }

  private deadline(): bigint {
    return BigInt(Math.floor(Date.now() / 1000) + this.policy.deadlineSeconds);
  }

  private async approve(side: TradeSide, wallet: Wallet, asset: Address, call: SwapCall, amount: bigint): Promise<TradeResult | null> {
    if (!call.approvalSpender) return null;
    const erc20 = await ensureAllowance(this.client, this.client.executor, wallet, asset, call.approvalSpender, amount);
    if (erc20 && erc20.status !== 'confirmed') return this.fromExec(side, wallet, erc20);
    if (call.permit2Spender) {
      const permit2 = await ensurePermit2Allowance(
        this.client,
        this.client.executor,
        wallet,
        call.approvalSpender,
        asset,
        call.permit2Spender,
        amount,
      );
      if (permit2 && permit2.status !== 'confirmed') return this.fromExec(side, wallet, permit2);
    }
    return null;
  }

  /** Both legs of our own swap, from the DEX's Swap event — the only record of a native V4 leg. */
  private fillFromSwapLogs(pool: PoolState, logs: readonly Log[]): { tokenOut: bigint; quoteOut: bigint } | null {
    const swaps = this.connector.parseSwapLogs(pool, logs);
    if (swaps.length === 0) return null;
    const tokenIs0 = sameAddress(pool.token0, this.info.token.address);
    return swaps.reduce(
      (acc, s) => ({
        tokenOut: acc.tokenOut + (tokenIs0 ? s.amount0Out : s.amount1Out),
        quoteOut: acc.quoteOut + (tokenIs0 ? s.amount1Out : s.amount0Out),
      }),
      { tokenOut: 0n, quoteOut: 0n },
    );
  }

  private filled(side: TradeSide, wallet: Wallet, exec: Extract<ExecResult, { status: 'confirmed' }>, quoteAmount: number, tokenAmount: number): TradeResult {
    return {
      status: 'filled',
      side,
      wallet: wallet.address,
      quoteAmount,
      tokenAmount,
      price: tokenAmount > 0 ? quoteAmount / tokenAmount : 0,
      hash: exec.hash,
      block: exec.block,
      feeNative: exec.feeNative,
    };
  }

  private failed(side: TradeSide, wallet: Wallet, error: string, hash?: Hex): TradeResult {
    return hash ? { status: 'failed', side, wallet: wallet.address, error, hash } : { status: 'failed', side, wallet: wallet.address, error };
  }

  private fromExec(side: TradeSide, wallet: Wallet, exec: Exclude<ExecResult, { status: 'confirmed' }>): TradeResult {
    if (exec.status === 'unknown') {
      return exec.hash
        ? { status: 'unknown', side, wallet: wallet.address, error: exec.error, hash: exec.hash }
        : { status: 'unknown', side, wallet: wallet.address, error: exec.error };
    }
    return this.failed(side, wallet, exec.error, exec.hash);
  }
}
