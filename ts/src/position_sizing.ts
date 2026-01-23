/**
 * Position Sizing - Kelly Criterion based sizing with safety limits
 * Implements fractional Kelly for conservative position sizing
 */

import { CONFIG } from "./config";

export interface PositionSizeInput {
    edge: number;           // Expected edge (true_prob - market_price)
    price: number;          // Current share price
    liquidity: number;      // Available liquidity in market
    asset: string;          // Asset being traded
    direction: "UP" | "DOWN";
}

export interface PositionSizeResult {
    sizeUsd: number;
    kellyFraction: number;
    reason: string;
}

// Track concurrent positions by direction for correlation limits
const activePositions: Map<string, { asset: string; direction: "UP" | "DOWN" }> = new Map();

/**
 * Calculate optimal position size using Kelly Criterion
 * 
 * Full Kelly = edge / (1 - price)
 * We use fractional Kelly (25%) for safety
 */
export function calculatePositionSize(
    input: PositionSizeInput,
    bankroll: number = 1000,
    config = {
        kellyFraction: 0.25,
        maxPositionSize: 50,
        maxLiquidityPercent: 0.5,
        minPositionSize: 5,
    }
): PositionSizeResult {
    const { edge, price, liquidity, asset, direction } = input;
    
    // Validate inputs
    if (edge <= 0) {
        return { sizeUsd: 0, kellyFraction: 0, reason: "No edge" };
    }
    
    if (price <= 0 || price >= 1) {
        return { sizeUsd: 0, kellyFraction: 0, reason: "Invalid price" };
    }
    
    // Full Kelly formula: edge / (1 - price)
    // This represents the optimal fraction of bankroll to bet
    const fullKelly = edge / (1 - price);
    
    // Apply fractional Kelly (25% of optimal = more conservative)
    const fractionalKelly = fullKelly * config.kellyFraction;
    
    // Calculate raw position size
    let sizeUsd = bankroll * fractionalKelly;
    let reason = `Kelly: ${(fractionalKelly * 100).toFixed(1)}%`;
    
    // Apply maximum position size limit
    if (sizeUsd > config.maxPositionSize) {
        sizeUsd = config.maxPositionSize;
        reason = `Capped at max: $${config.maxPositionSize}`;
    }
    
    // Apply liquidity limit (don't take more than 50% of available liquidity)
    const maxByLiquidity = liquidity * config.maxLiquidityPercent;
    if (sizeUsd > maxByLiquidity && maxByLiquidity > 0) {
        sizeUsd = maxByLiquidity;
        reason = `Limited by liquidity: $${maxByLiquidity.toFixed(2)}`;
    }
    
    // Check correlation limits
    const correlationLimit = checkCorrelationLimits(asset, direction);
    if (correlationLimit.reduce) {
        sizeUsd = sizeUsd * correlationLimit.factor;
        reason = `Reduced for correlation: ${correlationLimit.reason}`;
    }
    
    // Minimum position size
    if (sizeUsd < config.minPositionSize) {
        return { sizeUsd: 0, kellyFraction: fractionalKelly, reason: `Below minimum: $${config.minPositionSize}` };
    }
    
    return {
        sizeUsd: Math.round(sizeUsd * 100) / 100, // Round to cents
        kellyFraction: fractionalKelly,
        reason
    };
}

/**
 * Check correlation limits for concurrent positions
 * BTC, ETH, SOL are correlated - reduce size if too many same-direction bets
 */
function checkCorrelationLimits(
    asset: string,
    direction: "UP" | "DOWN"
): { reduce: boolean; factor: number; reason: string } {
    // Count positions in same direction
    let sameDirectionCount = 0;
    
    for (const [_, pos] of activePositions) {
        if (pos.direction === direction) {
            sameDirectionCount++;
        }
    }
    
    // If already have 2+ positions in same direction, reduce new position size
    if (sameDirectionCount >= 2) {
        return {
            reduce: true,
            factor: 0.5,
            reason: `${sameDirectionCount} existing ${direction} positions`
        };
    }
    
    return { reduce: false, factor: 1, reason: "" };
}

/**
 * Register an active position
 */
export function registerPosition(id: string, asset: string, direction: "UP" | "DOWN"): void {
    activePositions.set(id, { asset, direction });
}

/**
 * Remove a closed position
 */
export function removePosition(id: string): void {
    activePositions.delete(id);
}

/**
 * Get count of active positions
 */
export function getActivePositionCount(): number {
    return activePositions.size;
}

/**
 * Clear all tracked positions (for testing/reset)
 */
export function clearPositions(): void {
    activePositions.clear();
}
