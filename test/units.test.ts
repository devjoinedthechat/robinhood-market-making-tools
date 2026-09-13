import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError } from '../src/errors.ts';
import { applySlippage, numberToDecimalString, parseAmount } from '../src/units.ts';

describe('numberToDecimalString', () => {
  it('never emits exponent notation', () => {
    assert.equal(numberToDecimalString(1e-7), '0.0000001');
    assert.equal(numberToDecimalString(1.5e-7), '0.00000015');
    assert.equal(numberToDecimalString(1e21), '1000000000000000000000');
    assert.equal(numberToDecimalString(1.23e21), '1230000000000000000000');
  });

  it('keeps the shortest round-trip form, not the exact binary expansion', () => {
    assert.equal(numberToDecimalString(0.1), '0.1');
    assert.equal(numberToDecimalString(123.456), '123.456');
  });
});

describe('parseAmount', () => {
  it('converts 0.1 to exactly 1e17 wei, not 0.100000000000000005', () => {
    assert.equal(parseAmount(0.1, 18), 10n ** 17n);
  });

  it('truncates excess fraction digits instead of rounding up', () => {
    assert.equal(parseAmount('1.1234569', 6), 1_123_456n);
    assert.equal(parseAmount(0.0000019, 6), 1n);
  });

  it('handles high-supply amounts that toString renders with an exponent', () => {
    assert.equal(parseAmount(1e21, 18), 10n ** 39n);
  });

  it('accepts decimal strings with a bare leading or trailing point', () => {
    assert.equal(parseAmount('.5', 6), 500_000n);
    assert.equal(parseAmount('5.', 6), 5_000_000n);
  });

  it('returns zero for positive dust below one unit, leaving the caller to decide', () => {
    assert.equal(parseAmount('0.0000001', 6), 0n);
  });

  it('rejects negative, non-finite and non-decimal input', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 'abc', '1e5', '-1', '']) {
      assert.throws(() => parseAmount(bad as number | string, 18), ConfigError, `accepted ${String(bad)}`);
    }
  });
});

describe('applySlippage', () => {
  it('reduces by the percentage', () => {
    assert.equal(applySlippage(1_000n, 5), 950n);
    assert.equal(applySlippage(1_000n, 0.5), 995n);
  });

  it('never returns zero, so a floor always exists', () => {
    assert.equal(applySlippage(1_000n, 100), 1n);
    assert.equal(applySlippage(1_000n, 250), 1n);
  });

  it('treats NaN as no slippage rather than throwing on BigInt(NaN)', () => {
    assert.equal(applySlippage(1_000n, Number.NaN), 1_000n);
  });
});
