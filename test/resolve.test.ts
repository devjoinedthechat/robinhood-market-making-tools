import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getAddress, zeroAddress, type Address } from 'viem';
import { robinhood } from '../src/chains.ts';
import { ConfigError } from '../src/errors.ts';
import { chooseQuoteSide } from '../src/market/resolve.ts';
import { DEFAULT_TRADING_POLICY, resolveTradingPolicy } from '../src/market/types.ts';

const WETH = getAddress(robinhood.wrappedNative);
const USDG = getAddress('0x5fc5360d0400a0fd4f2af552add042d716f1d168');
const A: Address = '0x00000000000000000000000000000000000000A1';
const B: Address = '0x00000000000000000000000000000000000000B2';

describe('chooseQuoteSide', () => {
  it('prefers ETH or WETH whichever side it is on', () => {
    assert.deepEqual(chooseQuoteSide(A, WETH, robinhood), { token: A, quote: WETH, ambiguous: false });
    assert.deepEqual(chooseQuoteSide(zeroAddress, A, robinhood), { token: A, quote: zeroAddress, ambiguous: false });
  });

  it('prefers a known quote token over an unknown one, regardless of sort order', () => {
    assert.deepEqual(chooseQuoteSide(USDG, B, robinhood), { token: B, quote: USDG, ambiguous: false });
    assert.deepEqual(chooseQuoteSide(A, USDG, robinhood), { token: A, quote: USDG, ambiguous: false });
  });

  it('flags ambiguity instead of pretending to know', () => {
    assert.equal(chooseQuoteSide(A, B, robinhood).ambiguous, true);
    assert.equal(chooseQuoteSide(WETH, zeroAddress, robinhood).ambiguous, true);
  });

  it('honours an explicit quote, and rejects one that is not in the pool', () => {
    assert.deepEqual(chooseQuoteSide(USDG, WETH, robinhood, USDG), { token: WETH, quote: USDG, ambiguous: false });
    assert.throws(() => chooseQuoteSide(A, B, robinhood, USDG), ConfigError);
  });
});

describe('resolveTradingPolicy', () => {
  it('returns the defaults when nothing is overridden', () => {
    assert.deepEqual(resolveTradingPolicy(), DEFAULT_TRADING_POLICY);
  });

  it('rejects a default slippage above a cap, a short deadline and out-of-range percentages', () => {
    assert.throws(() => resolveTradingPolicy({ maxBuySlippagePct: 2 }), ConfigError);
    assert.throws(() => resolveTradingPolicy({ deadlineSeconds: 5 }), ConfigError);
    assert.throws(() => resolveTradingPolicy({ maxPriceImpactPct: 150 }), ConfigError);
  });
});
