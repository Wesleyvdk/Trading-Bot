/**
 * Latency Arbitrage Strategy
 * 
 * Core logic for exploiting the time delay between real-time prices and
 * Polymarket's binary outcome market odds.
 * 
 * Key concept: When BTC is significantly above/below the strike price with
 * little time remaining, the true probability of the outcome is near certain,
 * but market odds may lag behind.
 */

import type { Market, MarketPrices } from "./types";
import { getBinanceWS } from "./binance_ws";
import { calculatePositionSize } from "./position_sizing";
import type { PositionSizeResult } from "./position_sizing";
import { CONFIG } from "./config";

// Strategy configuration
export const LATENCY_CONFIG = {
    // Edge thresholds
    MIN_EDGE: 0.05,              // 5% minimum edge to trade
    
    // Time window (seconds)
    MIN_TIME_REMAINING: 30,      // Don't trade with < 30 seconds left
    MAX_TIME_REMAINING: 300,     // Don't trade more than 5 min before expiry
    
    // Position sizing
    KELLY_FRACTION: 0.25,        // Use 25% Kelly
    MAX_POSITION_SIZE: 50,       // Max $50 per trade
    MIN_POSITION_SIZE: 5,        // Min $5 per trade
    
    // Default volatility (per-minute percent, used if no live data)
    DEFAULT_VOL_BTC: 0.015,
    DEFAULT_VOL_ETH: 0.020,
    DEFAULT_VOL_SOL: 0.035,
};

/**
 * Result of evaluating a market for latency arbitrage opportunity
 */
export interface LatencyEvaluation {
    market: Market;
    currentPrice: number;           // Real-time exchange price
    strikePrice: number;            // Market strike price
    priceDeltas: number;            // Current - Strike (absolute)
    deltaPercent: number;           // Delta as percentage of strike
    
    trueProbabilityUp: number;      // Calculated true probability of UP
    trueProbabilityDown: number;    // Calculated true probability of DOWN
    
    marketPriceUp: number;          // Polymarket share price for UP
    marketPriceDown: number;        // Polymarket share price for DOWN
    
    edgeUp: number;                 // true_prob_up - market_price_up
    edgeDown: number;               // true_prob_down - market_price_down
    
    timeRemainingSeconds: number;   // Seconds until market closes
    
    recommendedSide: "UP" | "DOWN" | null;
    recommendedEdge: number;
    recommendedSize: PositionSizeResult | null;
    
    volatility: number;             // Per-minute volatility used
    reason: string;                 // Explanation of decision
}

/**
 * Normal CDF approximation using Horner's method
 * Used to convert z-scores to probabilities
 */
function normalCDF(z: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    
    const sign = z < 0 ? -1 : 1;
    const absZ = Math.abs(z) / Math.sqrt(2);
    
    const t = 1.0 / (1.0 + p * absZ);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absZ * absZ);
    
    return 0.5 * (1.0 + sign * y);
}

/**
 * Estimate the true probability that the asset will be ABOVE the strike price
 * at market close, given current price, time remaining, and volatility.
 * 
 * @param deltaPercent - (current_price - strike_price) / strike_price * 100
 * @param timeRemainingSeconds - Seconds until market closes
 * @param volatilityPerMinute - Per-minute volatility (std dev of percent changes)
 */
export function estimateProbabilityUp(
    deltaPercent: number,
    timeRemainingSeconds: number,
    volatilityPerMinute: number
): number {
    // Calculate expected price movement in remaining time
    // Using random walk: expected_move = volatility * sqrt(time)
    const minutesRemaining = timeRemainingSeconds / 60;
    const expectedMovePercent = volatilityPerMinute * Math.sqrt(minutesRemaining);
    
    // Handle edge cases
    if (expectedMovePercent < 0.001) {
        // Almost no time left - probability is essentially binary
        return deltaPercent > 0 ? 0.999 : 0.001;
    }
    
    // Z-score: how many standard deviations is the current price from strike?
    const zScore = deltaPercent / expectedMovePercent;
    
    // Clamp extreme values
    if (zScore > 4) return 0.9999;
    if (zScore < -4) return 0.0001;
    
    // Convert z-score to probability using normal CDF
    return normalCDF(zScore);
}

/**
 * Get volatility for an asset, preferring live calculation over defaults
 */
function getVolatility(asset: string): number {
    const binanceWS = getBinanceWS();
    
    if (binanceWS.connected) {
        const liveVol = binanceWS.getVolatility(asset);
        if (liveVol > 0) return liveVol;
    }
    
    // Fall back to defaults
    switch (asset.toUpperCase()) {
        case "BTC": return LATENCY_CONFIG.DEFAULT_VOL_BTC;
        case "ETH": return LATENCY_CONFIG.DEFAULT_VOL_ETH;
        case "SOL": return LATENCY_CONFIG.DEFAULT_VOL_SOL;
        default: return 0.025;
    }
}

/**
 * Get real-time price for an asset from Binance WebSocket
 */
function getRealTimePrice(asset: string): number | null {
    const binanceWS = getBinanceWS();
    return binanceWS.getPrice(asset);
}

/**
 * Evaluate a market for latency arbitrage opportunity
 */
export function evaluateMarket(
    market: Market,
    marketPrices: MarketPrices,
    config = LATENCY_CONFIG
): LatencyEvaluation {
    const now = Date.now();
    const endTime = new Date(market.end_date_iso).getTime();
    const timeRemainingSeconds = Math.max(0, (endTime - now) / 1000);
    
    // Get real-time price
    const currentPrice = getRealTimePrice(market.asset);
    const strikePrice = market.strike_price;
    
    // Base evaluation with null checks
    const baseEvaluation: LatencyEvaluation = {
        market,
        currentPrice: currentPrice || 0,
        strikePrice: strikePrice || 0,
        priceDeltas: 0,
        deltaPercent: 0,
        trueProbabilityUp: 0.5,
        trueProbabilityDown: 0.5,
        marketPriceUp: marketPrices.up_price,
        marketPriceDown: marketPrices.down_price,
        edgeUp: 0,
        edgeDown: 0,
        timeRemainingSeconds,
        recommendedSide: null,
        recommendedEdge: 0,
        recommendedSize: null,
        volatility: getVolatility(market.asset),
        reason: ""
    };
    
    // Check for missing data
    if (!currentPrice || !strikePrice) {
        baseEvaluation.reason = `Missing data: price=${currentPrice}, strike=${strikePrice}`;
        return baseEvaluation;
    }
    
    // Check time window
    if (timeRemainingSeconds < config.MIN_TIME_REMAINING) {
        baseEvaluation.reason = `Too late: ${timeRemainingSeconds.toFixed(0)}s remaining`;
        return baseEvaluation;
    }
    
    if (timeRemainingSeconds > config.MAX_TIME_REMAINING) {
        baseEvaluation.reason = `Too early: ${timeRemainingSeconds.toFixed(0)}s remaining`;
        return baseEvaluation;
    }
    
    // Calculate price delta
    const priceDelta = currentPrice - strikePrice;
    const deltaPercent = (priceDelta / strikePrice) * 100;
    
    // Get volatility
    const volatility = getVolatility(market.asset);
    
    // Estimate true probabilities
    const trueProbUp = estimateProbabilityUp(deltaPercent, timeRemainingSeconds, volatility);
    const trueProbDown = 1 - trueProbUp;
    
    // Calculate edges
    // For buying UP: edge = true_prob_up - price_to_buy_up (ask price)
    // For buying DOWN: edge = true_prob_down - price_to_buy_down (ask price)
    const edgeUp = trueProbUp - marketPrices.up_ask;
    const edgeDown = trueProbDown - marketPrices.down_ask;
    
    // Fill in evaluation
    const evaluation: LatencyEvaluation = {
        ...baseEvaluation,
        currentPrice,
        strikePrice,
        priceDeltas: priceDelta,
        deltaPercent,
        trueProbabilityUp: trueProbUp,
        trueProbabilityDown: trueProbDown,
        edgeUp,
        edgeDown,
        volatility
    };
    
    // Determine best side
    let bestSide: "UP" | "DOWN" | null = null;
    let bestEdge = 0;
    
    if (edgeUp > edgeDown && edgeUp > config.MIN_EDGE) {
        bestSide = "UP";
        bestEdge = edgeUp;
    } else if (edgeDown > config.MIN_EDGE) {
        bestSide = "DOWN";
        bestEdge = edgeDown;
    }
    
    if (!bestSide) {
        evaluation.reason = `No edge: UP=${(edgeUp * 100).toFixed(1)}%, DOWN=${(edgeDown * 100).toFixed(1)}%`;
        return evaluation;
    }
    
    // Calculate position size
    const price = bestSide === "UP" ? marketPrices.up_ask : marketPrices.down_ask;
    const liquidity = 1000; // TODO: Get real liquidity from orderbook
    
    const sizing = calculatePositionSize(
        {
            edge: bestEdge,
            price,
            liquidity,
            asset: market.asset,
            direction: bestSide
        },
        CONFIG.TRADE_SIZE_USD * 100, // Assume 100x trade size as bankroll
        {
            kellyFraction: config.KELLY_FRACTION,
            maxPositionSize: config.MAX_POSITION_SIZE,
            maxLiquidityPercent: 0.5,
            minPositionSize: config.MIN_POSITION_SIZE
        }
    );
    
    evaluation.recommendedSide = bestSide;
    evaluation.recommendedEdge = bestEdge;
    evaluation.recommendedSize = sizing;
    evaluation.reason = sizing.sizeUsd > 0 
        ? `${bestSide} edge=${(bestEdge * 100).toFixed(1)}%, size=$${sizing.sizeUsd}`
        : sizing.reason;
    
    return evaluation;
}

/**
 * Check if we should execute a trade based on evaluation
 */
export function shouldTrade(evaluation: LatencyEvaluation): boolean {
    return (
        evaluation.recommendedSide !== null &&
        evaluation.recommendedSize !== null &&
        evaluation.recommendedSize.sizeUsd > 0
    );
}

/**
 * Format evaluation for logging
 */
export function formatEvaluation(eval_: LatencyEvaluation): string {
    const timeStr = eval_.timeRemainingSeconds.toFixed(0) + "s";
    const priceStr = eval_.currentPrice?.toFixed(2) || "N/A";
    const strikeStr = eval_.strikePrice?.toFixed(2) || "N/A";
    const deltaStr = eval_.deltaPercent?.toFixed(3) || "0";
    const probUpStr = (eval_.trueProbabilityUp * 100).toFixed(1);
    const mktUpStr = (eval_.marketPriceUp * 100).toFixed(1);
    const edgeUpStr = (eval_.edgeUp * 100).toFixed(1);
    
    return [
        `[${eval_.market.asset} ${eval_.market.market_type}]`,
        `Time: ${timeStr}`,
        `Price: $${priceStr} / Strike: $${strikeStr}`,
        `Δ: ${deltaStr}%`,
        `TrueP(Up): ${probUpStr}% vs Mkt: ${mktUpStr}%`,
        `Edge(Up): ${edgeUpStr}%`,
        `→ ${eval_.reason}`
    ].join(" | ");
}
