// Enhanced Strategy V2 - Data-Driven Dynamic Trading
// Uses historical pattern analysis for optimal entry/exit decisions

import { Market, PricePoint, TradeOpportunity } from "./types";
import { ClobClient, Side } from "@polymarket/clob-client";
import { CONFIG } from "./config";
import { placeOrder } from "./execution";
import { getMarketPrices, calculateSpread, calculateUpside } from "./prices";
import { getSignals } from "./pattern_analyzer";
import { insertTradingSignal, upsertMarketWindow } from "./db";

// Price history for momentum calculation
let prices: PricePoint[] = [];
let lastTradeTime = 0;

// Position tracking
interface Position {
    market: Market;
    direction: "UP" | "DOWN";
    entryPrice: number;
    entryTime: number;
    tokenId: string;
    windowId?: number;
}

let activePositions: Map<string, Position> = new Map();

// Strategy configuration
const STRATEGY_CONFIG = {
    MIN_CONFIDENCE: 0.55,           // Minimum signal confidence to act
    PROFIT_TAKE_THRESHOLD: 0.75,    // Take profit when share price hits this
    STOP_LOSS_THRESHOLD: 0.25,      // Cut losses when share price drops to this
    MAX_POSITIONS: 3,               // Maximum concurrent positions
    COOLDOWN_MS: 30000,             // Cooldown between trades
    USE_PATTERN_SIGNALS: true,      // Enable pattern-based signals
    FALLBACK_TO_MOMENTUM: true,     // Use momentum when no pattern data
};

/**
 * Process a Binance price update with enhanced strategy
 */
export async function processPriceUpdateV2(
    price: number,
    time: number,
    client: ClobClient,
    markets: Market[]
): Promise<void> {
    const now = Date.now();
    prices.push({ price, timestamp: now });

    // Prune old data (> 70 mins)
    const cutoff = now - 70 * 60 * 1000;
    while (prices.length > 0 && prices[0]!.timestamp < cutoff) {
        prices.shift();
    }

    // Need at least 10 data points
    if (prices.length < 10) return;

    const currentPrice = prices[prices.length - 1]!.price;

    // 1. Check existing positions for exit signals
    await checkPositionsForExit(client, currentPrice);

    // 2. Look for new entry opportunities
    if (activePositions.size < STRATEGY_CONFIG.MAX_POSITIONS) {
        if (now - lastTradeTime >= STRATEGY_CONFIG.COOLDOWN_MS) {
            await findEntryOpportunities(client, markets, currentPrice, now);
        }
    }

    // Log status periodically
    if (Math.random() < 0.005) {
        console.log(`[V2] BTC: $${currentPrice.toFixed(2)} | Positions: ${activePositions.size}/${STRATEGY_CONFIG.MAX_POSITIONS}`);
    }
}

/**
 * Check active positions for exit/flip signals
 */
async function checkPositionsForExit(client: ClobClient, btcPrice: number): Promise<void> {
    for (const [key, position] of activePositions) {
        const market = position.market;

        // Get current share prices
        const marketPrices = await getMarketPrices(
            market.token_ids[0]!,
            market.token_ids[1]!
        );

        if (!marketPrices) continue;

        const currentSharePrice = position.direction === "UP"
            ? (marketPrices.up_bid + marketPrices.up_ask) / 2
            : (marketPrices.down_bid + marketPrices.down_ask) / 2;

        const oppositeSharePrice = position.direction === "UP"
            ? (marketPrices.down_bid + marketPrices.down_ask) / 2
            : (marketPrices.up_bid + marketPrices.up_ask) / 2;

        // Calculate time remaining
        const windowEnd = new Date(market.end_date_iso);
        const now = new Date();
        const minutesRemaining = Math.max(0, (windowEnd.getTime() - now.getTime()) / 60000);

        // Calculate current minute within window
        const duration = market.market_type === "15-MIN" ? 15 : 60;
        const currentMinute = Math.floor(duration - minutesRemaining);

        // Check for profit-taking
        if (currentSharePrice >= STRATEGY_CONFIG.PROFIT_TAKE_THRESHOLD) {
            // Get pattern-based signal
            const signal = await getSignals(
                market.market_type,
                currentMinute,
                btcPrice,
                market.strike_price || btcPrice,
                position.direction === "UP" ? currentSharePrice : oppositeSharePrice,
                position.direction === "DOWN" ? currentSharePrice : oppositeSharePrice
            );

            if (signal.action === "SELL" && signal.confidence > 0.40) {
                console.log(`[V2 EXIT] ${market.asset} ${market.market_type} ${position.direction}`);
                console.log(`   Reason: ${signal.reason}`);
                console.log(`   Share price: ${(currentSharePrice * 100).toFixed(1)}c | Profit: ${((currentSharePrice - position.entryPrice) * 100).toFixed(1)}c`);

                await executeSell(client, position, currentSharePrice);
                activePositions.delete(key);

                // Log signal to database
                if (position.windowId) {
                    await insertTradingSignal(
                        position.windowId,
                        "EXIT",
                        position.direction,
                        signal.confidence,
                        signal.reason,
                        btcPrice,
                        currentSharePrice,
                        Math.floor(minutesRemaining)
                    );
                }
                continue;
            }
        }

        // Check for stop-loss
        if (currentSharePrice <= STRATEGY_CONFIG.STOP_LOSS_THRESHOLD) {
            console.log(`[V2 STOP] ${market.asset} ${market.market_type} ${position.direction}`);
            console.log(`   Share price dropped to ${(currentSharePrice * 100).toFixed(1)}c`);

            // Consider flipping position
            if (oppositeSharePrice < 0.60 && minutesRemaining > 3) {
                console.log(`   Considering FLIP to ${position.direction === "UP" ? "DOWN" : "UP"}`);
                // For now, just exit. Flip logic can be added later.
            }

            await executeSell(client, position, currentSharePrice);
            activePositions.delete(key);
            continue;
        }

        // Check for time-based exit (last 2 minutes)
        if (minutesRemaining < 2) {
            // In final minutes, check if we should hold or exit
            const priceVsStrike = market.strike_price
                ? (btcPrice >= market.strike_price ? "above" : "below")
                : "unknown";

            const positionAligned = (position.direction === "UP" && priceVsStrike === "above") ||
                (position.direction === "DOWN" && priceVsStrike === "below");

            if (!positionAligned && currentSharePrice < 0.60) {
                console.log(`[V2 LATE EXIT] ${market.asset} - Position misaligned with price`);
                await executeSell(client, position, currentSharePrice);
                activePositions.delete(key);
            }
        }
    }
}

/**
 * Find new entry opportunities
 */
async function findEntryOpportunities(
    client: ClobClient,
    markets: Market[],
    btcPrice: number,
    now: number
): Promise<void> {
    // Filter to tradeable markets with strike prices
    const tradeableMarkets = markets.filter(m =>
        m.strike_price !== null &&
        !activePositions.has(getPositionKey(m))
    );

    for (const market of tradeableMarkets) {
        // Calculate time within window
        const windowEnd = new Date(market.end_date_iso);
        const duration = market.market_type === "15-MIN" ? 15 : 60;
        const windowStart = new Date(windowEnd.getTime() - duration * 60 * 1000);

        const nowDate = new Date();
        if (nowDate < windowStart || nowDate >= windowEnd) continue;

        const currentMinute = Math.floor((nowDate.getTime() - windowStart.getTime()) / 60000);
        const minutesRemaining = duration - currentMinute;

        // Skip if too late in the window
        if (minutesRemaining < 3) continue;

        // Get market prices
        const marketPrices = await getMarketPrices(
            market.token_ids[0]!,
            market.token_ids[1]!
        );

        if (!marketPrices) continue;

        // Check basic value filters
        const upMid = (marketPrices.up_bid + marketPrices.up_ask) / 2;
        const downMid = (marketPrices.down_bid + marketPrices.down_ask) / 2;

        // Get pattern-based signal
        const signal = await getSignals(
            market.market_type,
            currentMinute,
            btcPrice,
            market.strike_price!,
            upMid,
            downMid
        );

        if ((signal.action === "BUY_UP" || signal.action === "BUY_DOWN") &&
            signal.confidence >= STRATEGY_CONFIG.MIN_CONFIDENCE) {

            const direction = signal.action === "BUY_UP" ? "UP" : "DOWN";
            const entryPrice = direction === "UP" ? marketPrices.up_ask : marketPrices.down_ask;
            const tokenId = direction === "UP" ? market.token_ids[0]! : market.token_ids[1]!;

            // Additional value checks
            if (entryPrice > CONFIG.MAX_ENTRY_PRICE) continue;

            const spread = calculateSpread(
                direction === "UP" ? marketPrices.up_bid : marketPrices.down_bid,
                entryPrice
            );
            if (spread > CONFIG.MAX_SPREAD) continue;

            console.log(`[V2 ENTRY] ${market.asset} ${market.market_type} ${direction}`);
            console.log(`   Signal: ${signal.reason}`);
            console.log(`   Confidence: ${(signal.confidence * 100).toFixed(0)}%`);
            console.log(`   Entry: $${entryPrice.toFixed(3)} | Minutes left: ${minutesRemaining}`);

            // Create/get window ID for tracking
            const windowId = await upsertMarketWindow(
                market.market_type,
                market.asset,
                windowStart,
                windowEnd,
                market.strike_price,
                market.condition_id
            );

            // Execute the trade
            await placeOrder(client, tokenId, Side.BUY, CONFIG.TRADE_SIZE_USD, entryPrice);
            lastTradeTime = now;

            // Track position
            activePositions.set(getPositionKey(market), {
                market,
                direction,
                entryPrice,
                entryTime: now,
                tokenId,
                windowId
            });

            // Log signal to database
            await insertTradingSignal(
                windowId,
                "ENTRY",
                direction,
                signal.confidence,
                signal.reason,
                btcPrice,
                entryPrice,
                minutesRemaining
            );

            break; // Only one entry per update
        }

        // Fallback to momentum-based entry if no pattern data
        if (STRATEGY_CONFIG.FALLBACK_TO_MOMENTUM && signal.reason.includes("No pattern data")) {
            const momentum = calculateMomentum(market.market_type);
            if (momentum !== null && Math.abs(momentum) >= CONFIG.THRESHOLD_15M) {
                const direction = momentum > 0 ? "UP" : "DOWN";
                const entryPrice = direction === "UP" ? marketPrices.up_ask : marketPrices.down_ask;
                const tokenId = direction === "UP" ? market.token_ids[0]! : market.token_ids[1]!;

                if (entryPrice > CONFIG.MAX_ENTRY_PRICE) continue;

                console.log(`[V2 MOMENTUM] ${market.asset} ${market.market_type} ${direction}`);
                console.log(`   Momentum: ${(momentum * 100).toFixed(3)}%`);
                console.log(`   Entry: $${entryPrice.toFixed(3)}`);

                await placeOrder(client, tokenId, Side.BUY, CONFIG.TRADE_SIZE_USD, entryPrice);
                lastTradeTime = now;

                activePositions.set(getPositionKey(market), {
                    market,
                    direction,
                    entryPrice,
                    entryTime: now,
                    tokenId
                });

                break;
            }
        }
    }
}

/**
 * Execute a sell order
 */
async function executeSell(client: ClobClient, position: Position, currentPrice: number): Promise<void> {
    // Calculate approximate shares owned
    const sharesOwned = CONFIG.TRADE_SIZE_USD / position.entryPrice;

    await placeOrder(
        client,
        position.tokenId,
        Side.SELL,
        sharesOwned * currentPrice, // Approximate USD value
        currentPrice
    );
}

/**
 * Calculate momentum for a market type
 */
function calculateMomentum(marketType: string): number | null {
    if (prices.length < 10) return null;

    const now = Date.now();
    const window = marketType === "15-MIN" ? CONFIG.MOMENTUM_WINDOW_15M : CONFIG.MOMENTUM_WINDOW_60M;
    const threshold = marketType === "15-MIN" ? CONFIG.THRESHOLD_15M : CONFIG.THRESHOLD_60M;

    const targetTime = now - window * 60 * 1000;
    const pastPrice = prices.find(p => p.timestamp >= targetTime);

    if (!pastPrice) return null;

    const currentPrice = prices[prices.length - 1]!.price;
    return (currentPrice - pastPrice.price) / pastPrice.price;
}

/**
 * Get unique position key for a market
 */
function getPositionKey(market: Market): string {
    return `${market.asset}-${market.market_type}-${market.end_date_iso}`;
}

/**
 * Get current positions summary
 */
export function getPositionsSummary(): Array<{
    asset: string;
    marketType: string;
    direction: string;
    entryPrice: number;
    holdingTime: number;
}> {
    const now = Date.now();
    return Array.from(activePositions.values()).map(p => ({
        asset: p.market.asset,
        marketType: p.market.market_type,
        direction: p.direction,
        entryPrice: p.entryPrice,
        holdingTime: (now - p.entryTime) / 1000
    }));
}

/**
 * Get current momentum values (for external monitoring)
 */
export function getCurrentMomentumV2(): { mom15: number; mom60: number; price: number } | null {
    if (prices.length < 10) return null;

    const now = Date.now();
    const currentPrice = prices[prices.length - 1]!.price;

    const target15 = now - CONFIG.MOMENTUM_WINDOW_15M * 60 * 1000;
    const target60 = now - CONFIG.MOMENTUM_WINDOW_60M * 60 * 1000;

    const p15 = prices.find(p => p.timestamp >= target15);
    const p60 = prices.find(p => p.timestamp >= target60);

    if (!p15 || !p60) return null;

    return {
        mom15: (currentPrice - p15.price) / p15.price,
        mom60: (currentPrice - p60.price) / p60.price,
        price: currentPrice
    };
}
