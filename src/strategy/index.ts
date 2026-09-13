import { absorbWallStrategy, dipBuyStrategy } from './strategies/flow.ts';
import { gridStrategy } from './strategies/grid.ts';
import { inventoryRebalanceStrategy } from './strategies/inventory-rebalance.ts';
import { supportBuyStrategy, takeProfitStrategy } from './strategies/levels.ts';
import { twapStrategy } from './strategies/twap.ts';

export { absorbWallStrategy, dipBuyStrategy, type AbsorbWallParams, type DipBuyParams } from './strategies/flow.ts';
export { gridStrategy, type GridParams } from './strategies/grid.ts';
export { inventoryRebalanceStrategy, type InventoryRebalanceParams } from './strategies/inventory-rebalance.ts';
export { supportBuyStrategy, takeProfitStrategy, type SupportBuyParams, type TakeProfitParams } from './strategies/levels.ts';
export { twapStrategy, type TwapParams } from './strategies/twap.ts';

/** Every built-in strategy factory, for discovery: `strategies.grid({ stepPercent: 1 })`. */
export const strategies = {
  grid: gridStrategy,
  inventoryRebalance: inventoryRebalanceStrategy,
  twap: twapStrategy,
  supportBuy: supportBuyStrategy,
  takeProfit: takeProfitStrategy,
  dipBuy: dipBuyStrategy,
  absorbWall: absorbWallStrategy,
} as const;
