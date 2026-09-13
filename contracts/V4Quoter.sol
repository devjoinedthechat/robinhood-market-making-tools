// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * V4Quoter — exact, hook-aware quotes for Uniswap V4 pools.
 *
 * ══ WHY THIS EXISTS ══
 *
 * Robinhood Chain has a Uniswap V4 PoolManager but no V4Quoter deployed, on
 * either mainnet or testnet. Without one there are two ways to price a V4 swap
 * and only one of them is correct:
 *
 *   • Read slot0/liquidity and compute the swap off-chain. Fast, but a V4 pool
 *     may have a hook that changes the swap's outcome arbitrarily, so the
 *     number can be confidently wrong.
 *   • Ask the PoolManager to actually perform the swap and report the result.
 *     Exact by construction, hooks included, because it IS the swap.
 *
 * This does the second.
 *
 * ══ IT IS NEVER DEPLOYED ══
 *
 * The engine injects this contract's runtime bytecode at a scratch address
 * using an `eth_call` state override, so it exists only inside a single
 * simulated call and nothing is ever written to any chain. That is also why
 * `poolManager` is a PARAMETER rather than an immutable or a storage variable:
 * Solidity fills immutables in during construction, and injected runtime
 * bytecode is never constructed, so an immutable here would read as zero.
 *
 * ══ HOW THE RESULT GETS OUT ══
 *
 * A quote must not change state. The swap is performed inside the PoolManager's
 * unlock callback and then this contract REVERTS with the resulting deltas
 * encoded in a custom error. The revert unwinds the swap entirely — nothing is
 * settled, no token is moved, no approval is needed — while the error payload
 * carries the exact amounts back out. `quoteExactInputSingle` catches that
 * revert and decodes it. This is the same revert-with-result trick Uniswap's
 * own V3 QuoterV2 and V4Quoter use.
 *
 * Any other revert (no liquidity, a hook refusing the trade) is re-thrown
 * unchanged rather than being decoded as a quote — see `_bubble`.
 */

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 delta);
}

contract V4Quoter {
    /// Carries a successful quote out through the revert that undoes the swap.
    error QuoteResult(int128 amount0, int128 amount1);

    /// The callback returned normally, which should be impossible.
    error UnexpectedSuccess();

    /**
     * Price limits, from v4-core's TickMath.
     *
     * A swap is given the widest legal limit so it is bounded only by the
     * liquidity actually in the pool. Quoting against a tighter limit would
     * silently understate what the pool can fill.
     */
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    /**
     * Quote one exact-input swap.
     *
     * Returns the pool's balance deltas from the trader's point of view: the
     * negative side is what leaves the trader, the positive side is what the
     * trader receives.
     */
    function quoteExactInputSingle(
        address poolManager,
        PoolKey calldata key,
        bool zeroForOne,
        uint128 amountIn,
        bytes calldata hookData
    ) external returns (int128 amount0, int128 amount1) {
        try IPoolManager(poolManager).unlock(abi.encode(key, zeroForOne, amountIn, hookData)) returns (bytes memory) {
            revert UnexpectedSuccess();
        } catch (bytes memory reason) {
            return _decode(reason);
        }
    }

    /// Called by the PoolManager inside `unlock`. Always reverts.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool zeroForOne, uint128 amountIn, bytes memory hookData) =
            abi.decode(data, (PoolKey, bool, uint128, bytes));

        int256 delta = IPoolManager(msg.sender).swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                // Negative means exact input in v4.
                amountSpecified: -int256(uint256(amountIn)),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            hookData
        );

        // BalanceDelta packs amount0 in the high 128 bits and amount1 in the low.
        revert QuoteResult(int128(delta >> 128), int128(delta));
    }

    /**
     * Pull the amounts out of our own error, and re-throw anything else.
     *
     * Treating an arbitrary revert as a quote is the failure this guards
     * against: a hook rejecting the trade would otherwise be decoded as
     * whatever its error bytes happened to look like, and reported as a price.
     */
    function _decode(bytes memory reason) private pure returns (int128 amount0, int128 amount1) {
        if (reason.length != 4 + 64 || bytes4(reason) != QuoteResult.selector) {
            _bubble(reason);
        }
        assembly {
            amount0 := mload(add(reason, 0x24))
            amount1 := mload(add(reason, 0x44))
        }
    }

    function _bubble(bytes memory reason) private pure {
        if (reason.length == 0) revert UnexpectedSuccess();
        assembly {
            revert(add(reason, 0x20), mload(reason))
        }
    }
}
