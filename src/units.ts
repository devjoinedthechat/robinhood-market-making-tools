/**
 * Human amounts ↔ raw integer units.
 *
 * The public API takes human units (`0.01` ETH, `"250.5"` tokens) because that
 * is what people reason in. Everything that touches the chain is a bigint.
 * Conversion happens here and nowhere else.
 */

import { formatUnits, parseUnits } from 'viem';
import { ConfigError } from './errors.ts';

/**
 * A human-unit amount. Prefer a decimal string where exactness matters: a
 * `number` carries ~15-16 significant digits, so an 18-decimal balance does not
 * round-trip at the wei level.
 */
export type Amount = number | string;

const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * The shortest decimal that round-trips `value`, without exponent notation.
 *
 * `toString` uses exponents below 1e-6 and from 1e21, which `parseUnits`
 * rejects — that made high-supply tokens untradable. `toFixed`/`Intl` format
 * the exact binary value instead, so 0.1 became 0.100000000000000005.
 */
export function numberToDecimalString(value: number): string {
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const digits = `${match[1]}${match[2] ?? ''}`;
  const point = (match[1] as string).length + Number(match[3]);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Parse a human amount into raw units. Excess fractional digits are TRUNCATED,
 * never rounded, so a conversion can never exceed what the caller wrote.
 *
 * Throws `ConfigError` for negative, non-finite or non-decimal input. A
 * positive amount below one raw unit returns 0n; callers decide what that means.
 */
export function parseAmount(amount: Amount, decimals: number): bigint {
  let text: string;
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || amount < 0) throw new ConfigError(`Invalid amount: ${amount}`);
    text = numberToDecimalString(amount);
  } else {
    text = amount.trim();
    if (!DECIMAL.test(text)) {
      throw new ConfigError(`Invalid amount "${amount}": expected a non-negative decimal like "1.25"`);
    }
  }
  const [whole = '0', fraction = ''] = text.split('.');
  const kept = fraction.slice(0, Math.max(0, decimals));
  return parseUnits(kept ? `${whole || '0'}.${kept}` : whole || '0', decimals);
}

/** Raw units → human number. Lossy above ~15 significant digits; see `Amount`. */
export function formatAmount(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

/** `amountOut` reduced by `slippagePct` percent, never below 1 raw unit. */
export function applySlippage(amountOut: bigint, slippagePct: number): bigint {
  const pct = Number.isFinite(slippagePct) ? Math.max(0, Math.min(100, slippagePct)) : 0;
  const bps = BigInt(Math.floor(pct * 100));
  const reduced = (amountOut * (10_000n - bps)) / 10_000n;
  return reduced > 0n ? reduced : 1n;
}
