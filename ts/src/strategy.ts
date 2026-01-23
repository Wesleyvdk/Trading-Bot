// @ts-nocheck
import { Market, PricePoint, TradeOpportunity } from "./types";
import { ClobClient, Side } from "@polymarket/clob-client";
import { CONFIG } from "./config";
import { placeOrder } from "./execution";
import { getMarketPrices, calculateSpread, calculateUpside } from "./prices";

let prices: PricePoint[] = [];
let lastTradeTime = 0;

/**
 * Process a Binance price update and evaluate trading opportunities
 */
export async function processPriceUpdate(
    price: number, 
    time: number, 
    client: ClobClient,
    markets: Market[]
) {
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

    // Calculate momentum over different windows
    const target15 = now - CONFIG.MOMENTUM_WINDOW_15M * 60 * 1000;
    const target60 = now - CONFIG.MOMENTUM_WINDOW_60M * 60 * 1000;

    const p15 = findPriceAtTime(target15);
    const p60 = findPriceAtTime(target60);

    if (!p15 || !p60) return;

    const mom15 = (currentPrice - p15.price) / p15.price;
    const mom60 = (currentPrice - p60.price) / p60.price;

    // Log periodically (1% of updates)
    if (Math.random() < 0.01) {
        console.log(`[MOMENTUM] BTC: $${currentPrice.toFixed(2)} | 15m: ${(mom15*100).toFixed(3)}% | 60m: ${(mom60*100).toFixed(3)}%`);
    }

    // Check if momentum threshold is met
    if (Math.abs(mom15) < CONFIG.THRESHOLD_15M) {
        return; // No momentum signal
    }

    // Cooldown check (don't trade too frequently)
    if (now - lastTradeTime < 30000) {
        return; // Wait at least 30 seconds between trades
    }

    // Find best trading opportunity across all markets
    const opportunity = await findBestOpportunity(markets, mom15);
    
    if (opportunity) {
        console.log(`[OPPORTUNITY] ${opportunity.market.asset} ${opportunity.direction}`);
        console.log(`   Entry: $${opportunity.entry_price.toFixed(3)} | Upside: ${(opportunity.potential_upside * 100).toFixed(1)}% | Spread: ${(opportunity.spread * 100).toFixed(1)}%`);
        
        // Execute the trade
        await placeOrder(client, opportunity.token_id, Side.BUY, CONFIG.TRADE_SIZE_USD, opportunity.entry_price);
        lastTradeTime = now;
    }
}

/**
 * Find the best trading opportunity across all markets
 */
async function findBestOpportunity(markets: Market[], momentum: number): Promise<TradeOpportunity | null> {
    const opportunities: TradeOpportunity[] = [];
    const direction = momentum > 0 ? "UP" : "DOWN";

    for (const market of markets) {
        // Skip markets without strike price (not tradeable yet - price to beat not set)
        if (!market.strike_price) {
            // Only log occasionally to avoid spam
            if (Math.random() < 0.01) {
                console.log(`   ⏭️ Skip ${market.asset} ${market.market_type}: strike price not set yet`);
            }
            continue;
        }

        // Fetch current Polymarket prices
        const marketPrices = await getMarketPrices(
            market.token_ids[0]!, // Up token
            market.token_ids[1]!  // Down token
        );

        if (!marketPrices) {
            console.log(`   ⚠️ Could not fetch prices for ${market.asset} ${market.market_type}`);
            continue;
        }

        // Determine which token to buy based on momentum direction
        const tokenId = direction === "UP" ? market.token_ids[0]! : market.token_ids[1]!;
        const entryPrice = direction === "UP" ? marketPrices.up_ask : marketPrices.down_ask;
        const bid = direction === "UP" ? marketPrices.up_bid : marketPrices.down_bid;
        const ask = entryPrice;

        // Calculate metrics
        const spread = calculateSpread(bid, ask);
        const upside = calculateUpside(entryPrice);

        // Apply Value Filters
        if (entryPrice > CONFIG.MAX_ENTRY_PRICE) {
            console.log(`   ⏭️ Skip ${market.asset} ${market.market_type}: price ${entryPrice.toFixed(3)} > MAX ${CONFIG.MAX_ENTRY_PRICE}`);
            continue;
        }

        if (upside < CONFIG.MIN_UPSIDE) {
            console.log(`   ⏭️ Skip ${market.asset} ${market.market_type}: upside ${(upside*100).toFixed(1)}% < MIN ${CONFIG.MIN_UPSIDE*100}%`);
            continue;
        }

        if (spread > CONFIG.MAX_SPREAD) {
            console.log(`   ⏭️ Skip ${market.asset} ${market.market_type}: spread ${(spread*100).toFixed(1)}% > MAX ${CONFIG.MAX_SPREAD*100}%`);
            continue;
        }

        // STRIKE PRICE CHECK (Price to Beat)
        if (market.strike_price) {
            const buffer = CONFIG.STRIKE_PRICE_BUFFER || 0.005; // Default 0.5%
            
            // If buying UP (Yes), we want current price to be close to or above strike
            // We don't want to buy "Yes > $100k" if BTC is at $95k (too risky/far)
            // But we might buy if BTC is at $99.5k (momentum play)
            if (direction === "UP") {
                const minPrice = market.strike_price * (1 - buffer);
                if (marketPrices.up_price < minPrice) { // Using underlying asset price would be better, but we have momentum price
                     // Wait, we need the UNDERLYING asset price here, not the share price.
                     // We have 'momentum' which is calculated from 'currentPrice' (BTC price).
                     // Let's get the latest price from the prices array.
                     const latestPrice = prices[prices.length - 1]?.price;
                     if (latestPrice && latestPrice < minPrice) {
                         console.log(`   ⏭️ Skip ${market.asset} ${market.market_type}: BTC $${latestPrice} is too far below strike $${market.strike_price}`);
                         continue;
                     }
                }
            }
            
            // If buying DOWN (No), we want current price to be close to or below strike
            if (direction === "DOWN") {
                const maxPrice = market.strike_price * (1 + buffer);
                 const latestPrice = prices[prices.length - 1]?.price;
                 if (latestPrice && latestPrice > maxPrice) {
                     console.log(`   ⏭️ Skip ${market.asset} ${market.market_type}: BTC $${latestPrice} is too far above strike $${market.strike_price}`);
                     continue;
                 }
            }
        }

        // This is a valid opportunity
        opportunities.push({
            market,
            direction,
            token_id: tokenId,
            entry_price: entryPrice,
            potential_upside: upside,
            momentum: momentum,
            spread
        });
    }

    if (opportunities.length === 0) {
        return null;
    }

    // Sort by upside potential (best opportunity first)
    opportunities.sort((a, b) => b.potential_upside - a.potential_upside);

    return opportunities[0] || null;
}

/**
 * Find the price point closest to the given timestamp
 */
function findPriceAtTime(timestamp: number): PricePoint | null {
    for (const p of prices) {
        if (p.timestamp >= timestamp) {
            return p;
        }
    }
    return null;
}

/**
 * Get current momentum values (for external monitoring)
 */
export function getCurrentMomentum(): { mom15: number; mom60: number; price: number } | null {
    if (prices.length < 10) return null;
    
    const now = Date.now();
    const currentPrice = prices[prices.length - 1]!.price;
    
    const target15 = now - CONFIG.MOMENTUM_WINDOW_15M * 60 * 1000;
    const target60 = now - CONFIG.MOMENTUM_WINDOW_60M * 60 * 1000;
    
    const p15 = findPriceAtTime(target15);
    const p60 = findPriceAtTime(target60);
    
    if (!p15 || !p60) return null;
    
    return {
        mom15: (currentPrice - p15.price) / p15.price,
        mom60: (currentPrice - p60.price) / p60.price,
        price: currentPrice
    };
}
