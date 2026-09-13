/**
 * Every error this SDK throws on purpose.
 *
 * Callers branch on `instanceof` (or on `code`, which survives serialisation),
 * never on message text. The engine this SDK was extracted from classified run
 * outcomes by regex-matching error strings, which broke the moment a message
 * was reworded.
 */

export type ErrorCode =
  | 'invalid_config'
  | 'read_failed'
  | 'pool_not_found'
  | 'broadcast_blocked'
  | 'risk_limit'
  | 'strategy_not_ready'
  | 'wallets_busy';

export class MarketMakerError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A caller-supplied value is unusable. Thrown before anything touches the chain. */
export class ConfigError extends MarketMakerError {
  constructor(message: string) {
    super('invalid_config', message);
  }
}

/**
 * An RPC read failed.
 *
 * A failed read is never reported as zero: an empty wallet and an unreachable
 * node are different facts, and conflating them makes a funded wallet look empty.
 */
export class ReadError extends MarketMakerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('read_failed', message, options);
  }
}

export class PoolNotFoundError extends MarketMakerError {
  readonly ref: string;

  constructor(ref: string, message: string) {
    super('pool_not_found', message);
    this.ref = ref;
  }
}

/** The client was created with `readOnly: true` and something tried to broadcast. */
export class BroadcastBlockedError extends MarketMakerError {
  constructor(what: string) {
    super(
      'broadcast_blocked',
      `Broadcast blocked (readOnly client) while attempting: ${what}. Reads, quotes and simulations still work.`,
    );
  }
}

export type RiskLimitKind = 'spend-cap' | 'drawdown' | 'liquidity-floor';

/**
 * A risk limit stopped trading. This is the system working, not a failure: a
 * run that ends this way reports `status: 'halted'`.
 */
export class RiskLimitError extends MarketMakerError {
  readonly limit: RiskLimitKind;
  readonly observed: number;
  readonly threshold: number;

  constructor(limit: RiskLimitKind, observed: number, threshold: number, message: string) {
    super('risk_limit', message);
    this.limit = limit;
    this.observed = observed;
    this.threshold = threshold;
  }
}

export class StrategyNotReadyError extends MarketMakerError {
  readonly strategy: string;

  constructor(strategy: string, reason: string) {
    super('strategy_not_ready', `${strategy} cannot start: ${reason}`);
    this.strategy = strategy;
  }
}

/** Another run on this client is already trading one of these wallets. */
export class WalletsBusyError extends MarketMakerError {
  readonly addresses: readonly string[];

  constructor(addresses: readonly string[], heldBy: string) {
    super(
      'wallets_busy',
      `${addresses.length} wallet(s) are already being traded by "${heldBy}". ` +
        'Two runs sharing a wallet race each other for nonces and balances.',
    );
    this.addresses = addresses;
  }
}
