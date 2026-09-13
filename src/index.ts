/**
 * robinhood-market-making-tools — market making on Robinhood Chain.
 *
 * Layers, lowest first. Each depends only on the ones above it in this list:
 *
 *   chains, units, wallet, errors, logger    pure data and primitives
 *   client/   ChainClient, TransactionExecutor   reads, balances, safe execution
 *   dex/      connectors + DexRegistry           pool reads, quotes, calldata
 *   market/   Market, trade feeds, resolution    trading policy and fill accounting
 *   risk/     GuardedMarket                      spend cap, drawdown, liquidity floor, paper
 *   strategy/ Fleet, strategies, runner          what to trade, supervised
 *   MarketMaker                                   the front door
 */

// ── chains & primitives ─────────────────────────────────────────────────────
export { chains, explorerAddressUrl, explorerTxUrl, robinhood, robinhoodTestnet } from './chains.ts';
export type { DexDeployment, DexKind, QuoteToken, RobinhoodChain } from './chains.ts';
export { applySlippage, formatAmount, parseAmount, type Amount } from './units.ts';
export { generateWallet, walletFromAccount, walletFromPrivateKey, type Wallet } from './wallet.ts';
export { consoleLogger, scopedLogger, silentLogger, type LogData, type Logger, type LogLevel } from './logger.ts';
export {
  BroadcastBlockedError,
  ConfigError,
  MarketMakerError,
  PoolNotFoundError,
  ReadError,
  RiskLimitError,
  StrategyNotReadyError,
  WalletsBusyError,
  type ErrorCode,
  type RiskLimitKind,
} from './errors.ts';

// ── client ──────────────────────────────────────────────────────────────────
export { ChainClient, type ChainClientOptions, type TxOutcome } from './client/chain-client.ts';
export {
  TransactionExecutor,
  classifyBroadcastError,
  type BroadcastFailure,
  type ExecOptions,
  type ExecResult,
  type ExecutorDeps,
  type Fees,
  type TxRequest,
} from './client/executor.ts';

// ── dex ─────────────────────────────────────────────────────────────────────
export { DexRegistry, type PoolMatch } from './dex/registry.ts';
export { UniswapV2Connector } from './dex/uniswap-v2.ts';
export { UniswapV3Connector } from './dex/uniswap-v3.ts';
export { UniswapV4Connector, poolIdOf } from './dex/uniswap-v4.ts';
export { poolDepth } from './dex/types.ts';
export type { ConcentratedState, DexConnector, DexQuote, PoolState, SwapCall, SwapLog, V4PoolKey } from './dex/types.ts';

// ── market ──────────────────────────────────────────────────────────────────
export { Market, type MarketDeps } from './market/market.ts';
export { chooseQuoteSide, resolveMarket, type QuoteSideChoice, type ResolveMarketOptions } from './market/resolve.ts';
export { DEFAULT_TRADING_POLICY, resolveTradingPolicy } from './market/types.ts';
export type {
  BuyOrder,
  ExternalTrade,
  MarketChainInfo,
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
} from './market/types.ts';

// ── risk ────────────────────────────────────────────────────────────────────
export { GuardedMarket, validateRiskLimits, type GuardedMarketOptions, type LedgerSnapshot, type RiskLimits } from './risk/guarded-market.ts';

// ── strategies ──────────────────────────────────────────────────────────────
export { Fleet, type BuyerCandidate, type FleetOptions, type Holding } from './strategy/fleet.ts';
export { runStrategies, WalletLocks, type RunEvent, type RunOptions, type RunResult, type RunStatus, type StrategyOutcome } from './strategy/runner.ts';
export { assertParams, attempt, check, noteResult, readPrice, worthGas } from './strategy/support.ts';
export type { Readiness, Strategy, StrategyContext, StrategyMetrics } from './strategy/types.ts';
export * from './strategy/index.ts';

// ── front door ──────────────────────────────────────────────────────────────
export { MarketMaker, createMarketMaker, type MarketMakerOptions, type PoolCandidate } from './market-maker.ts';
