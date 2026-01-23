/**
 * Latency Arbitrage Bot - Main entry point
 * 
 * Runs the latency arbitrage strategy in a loop, evaluating markets
 * every 500ms for opportunities near expiry.
 */

import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { CONFIG } from "./config";
import { updateMarkets, refetchMissingStrikePrices } from "./market";
import { getMarketPrices } from "./prices";
import { getBinanceWS } from "./binance_ws";
import { 
    evaluateMarket, 
    shouldTrade, 
    formatEvaluation, 
    LATENCY_CONFIG 
} from "./latency_strategy";
import { placeOrder } from "./execution";
import { 
    insertStrategyTrade, 
    updateTradeOutcome,
    getDailyPerformance,
    initDataTables 
} from "./db";
import { registerPosition, removePosition, getActivePositionCount } from "./position_sizing";
import type { Market } from "./types";
import { Side } from "@polymarket/clob-client";

// Log prefix to distinguish from momentum bot
const LOG_PREFIX = "[LATENCY]";

// Session tracking
let sessionStats = {
    evaluated: 0,
    traded: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    startTime: Date.now()
};

// Active positions tracking
interface ActivePosition {
    market: Market;
    direction: "UP" | "DOWN";
    entryPrice: number;
    entryTime: number;
    tokenId: string;
    sizeUsd: number;
    expectedEdge: number;
    tradeId?: number;
}

const activePositions: Map<string, ActivePosition> = new Map();

/**
 * Initialize the CLOB client
 */
async function initClient(): Promise<ClobClient> {
    if (!CONFIG.POLYMARKET_PRIVATE_KEY) {
        throw new Error("POLYMARKET_PRIVATE_KEY not set");
    }
    
    const wallet = new Wallet(CONFIG.POLYMARKET_PRIVATE_KEY);
    
    const client = new ClobClient(
        CONFIG.POLYMARKET_CLOB_URL,
        CONFIG.CHAIN_ID,
        wallet,
        undefined,
        undefined,
        undefined,
        CONFIG.POLYMARKET_API_KEY ? {
            key: CONFIG.POLYMARKET_API_KEY,
            secret: CONFIG.POLYMARKET_API_SECRET!,
            passphrase: CONFIG.POLYMARKET_PASSPHRASE!
        } : undefined
    );
    
    return client;
}

/**
 * Get position key for a market
 */
function getPositionKey(market: Market): string {
    return `${market.asset}-${market.market_type}-${market.condition_id}`;
}

/**
 * Execute a trade
 */
async function executeTrade(
    client: ClobClient,
    market: Market,
    direction: "UP" | "DOWN",
    price: number,
    sizeUsd: number,
    edge: number
): Promise<void> {
    const tokenId = direction === "UP" ? market.token_ids[0]! : market.token_ids[1]!;
    const positionKey = getPositionKey(market);
    
    console.log(`\n${LOG_PREFIX} 🎯 TRADE: ${market.asset} ${market.market_type} ${direction}`);
    console.log(`${LOG_PREFIX}    Price: $${price.toFixed(3)} | Size: $${sizeUsd.toFixed(2)} | Edge: ${(edge * 100).toFixed(1)}%`);
    
    // Record trade in database
    const tradeId = await insertStrategyTrade({
        strategy: "latency",
        marketType: market.market_type,
        asset: market.asset,
        direction,
        entryPrice: price,
        expectedEdge: edge,
        tradeSizeUsd: sizeUsd,
        conditionId: market.condition_id
    });
    
    // Execute order
    await placeOrder(client, tokenId, Side.BUY, sizeUsd, price);
    
    // Track position
    const position: ActivePosition = {
        market,
        direction,
        entryPrice: price,
        entryTime: Date.now(),
        tokenId,
        sizeUsd,
        expectedEdge: edge,
        tradeId
    };
    
    activePositions.set(positionKey, position);
    registerPosition(positionKey, market.asset, direction);
    
    sessionStats.traded++;
}

/**
 * Check for position exits (market resolution)
 */
async function checkPositionExits(): Promise<void> {
    const now = Date.now();
    
    for (const [key, position] of activePositions) {
        const endTime = new Date(position.market.end_date_iso).getTime();
        
        // Market has closed
        if (now > endTime + 60000) { // 1 minute buffer for resolution
            const binanceWS = getBinanceWS();
            const finalPrice = binanceWS.getPrice(position.market.asset);
            const strikePrice = position.market.strike_price;
            
            if (finalPrice && strikePrice) {
                const actualUp = finalPrice > strikePrice;
                const won = (position.direction === "UP" && actualUp) || 
                           (position.direction === "DOWN" && !actualUp);
                
                // Calculate P&L
                // If won: receive $1 per share, paid entry price
                // If lost: receive $0, lost entry price
                const sharesHeld = position.sizeUsd / position.entryPrice;
                const pnl = won 
                    ? (1 - position.entryPrice) * sharesHeld 
                    : -position.sizeUsd;
                
                console.log(`\n📊 POSITION CLOSED: ${position.market.asset} ${position.direction}`);
                console.log(`   Result: ${won ? "✅ WIN" : "❌ LOSS"} | P&L: $${pnl.toFixed(2)}`);
                
                // Update database
                if (position.tradeId) {
                    await updateTradeOutcome(
                        position.tradeId,
                        won ? 1 : 0,
                        pnl,
                        won ? "WIN" : "LOSS"
                    );
                }
                
                // Update session stats
                if (won) {
                    sessionStats.wins++;
                } else {
                    sessionStats.losses++;
                }
                sessionStats.pnl += pnl;
                
                // Remove position
                activePositions.delete(key);
                removePosition(key);
            }
        }
    }
}

/**
 * Main strategy loop
 */
async function runLoop(client: ClobClient): Promise<void> {
    console.log(`\n${LOG_PREFIX} 🚀 Starting Latency Arbitrage Bot...`);
    console.log(`${LOG_PREFIX}    Mode: ${CONFIG.LIVE_MODE ? "🔴 LIVE" : "🔶 DRY RUN"}`);
    console.log(`${LOG_PREFIX}    Min Edge: ${LATENCY_CONFIG.MIN_EDGE * 100}%`);
    console.log(`${LOG_PREFIX}    Time Window: ${LATENCY_CONFIG.MIN_TIME_REMAINING}s - ${LATENCY_CONFIG.MAX_TIME_REMAINING}s`);
    console.log(`${LOG_PREFIX}    Max Position: $${LATENCY_CONFIG.MAX_POSITION_SIZE}`);
    
    // Initialize Binance WebSocket
    const binanceWS = getBinanceWS();
    await binanceWS.connect();
    
    // Wait for initial prices
    console.log(`${LOG_PREFIX} ⏳ Waiting for price data...`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Fetch initial markets
    let markets = await updateMarkets(client);
    let lastMarketUpdate = Date.now();
    
    // Main loop
    while (true) {
        try {
            // Refresh markets every 2 minutes
            if (Date.now() - lastMarketUpdate > 120000) {
                markets = await updateMarkets(client);
                lastMarketUpdate = Date.now();
            }
            
            // Refetch missing strike prices
            markets = await refetchMissingStrikePrices(markets);
            
            // Check for position exits
            await checkPositionExits();
            
            // Evaluate each market
            for (const market of markets) {
                const positionKey = getPositionKey(market);
                
                // Skip if we already have a position
                if (activePositions.has(positionKey)) continue;
                
                // Skip if missing strike price
                if (!market.strike_price) continue;
                
                // Get market prices
                const prices = await getMarketPrices(
                    market.token_ids[0]!,
                    market.token_ids[1]!
                );
                
                if (!prices) continue;
                
                // Evaluate for latency arbitrage
                const evaluation = evaluateMarket(market, prices);
                sessionStats.evaluated++;
                
                // Log evaluation every 10th market or if tradeable
                if (shouldTrade(evaluation) || sessionStats.evaluated % 10 === 0) {
                    console.log(formatEvaluation(evaluation));
                }
                
                // Execute if tradeable
                if (shouldTrade(evaluation) && evaluation.recommendedSize) {
                    await executeTrade(
                        client,
                        market,
                        evaluation.recommendedSide!,
                        evaluation.recommendedSide === "UP" ? prices.up_ask : prices.down_ask,
                        evaluation.recommendedSize.sizeUsd,
                        evaluation.recommendedEdge
                    );
                }
            }
            
            // Wait before next loop
            await new Promise(resolve => setTimeout(resolve, 500));
            
        } catch (error) {
            console.error("❌ Loop error:", error);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

/**
 * Print session summary
 */
function printSessionSummary(): void {
    const runtime = (Date.now() - sessionStats.startTime) / 1000 / 60;
    const winRate = sessionStats.traded > 0 
        ? (sessionStats.wins / sessionStats.traded * 100).toFixed(1) 
        : "N/A";
    
    console.log("\n📊 SESSION SUMMARY");
    console.log(`   Runtime: ${runtime.toFixed(1)} minutes`);
    console.log(`   Markets Evaluated: ${sessionStats.evaluated}`);
    console.log(`   Trades Executed: ${sessionStats.traded}`);
    console.log(`   Win/Loss: ${sessionStats.wins}/${sessionStats.losses}`);
    console.log(`   Win Rate: ${winRate}%`);
    console.log(`   Session P&L: $${sessionStats.pnl.toFixed(2)}`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
    console.log("═".repeat(60));
    console.log("   LATENCY ARBITRAGE BOT");
    console.log("   Strategy: Exploit time delay between exchange prices and Polymarket odds");
    console.log("═".repeat(60));
    
    try {
        // Initialize database
        await initDataTables();
        
        // Initialize client
        const client = await initClient();
        console.log("✅ CLOB client initialized");
        
        // Handle shutdown
        process.on("SIGINT", () => {
            console.log("\n⚠️ Shutting down...");
            printSessionSummary();
            getBinanceWS().disconnect();
            process.exit(0);
        });
        
        // Run main loop
        await runLoop(client);
        
    } catch (error) {
        console.error("❌ Fatal error:", error);
        printSessionSummary();
        process.exit(1);
    }
}

// Run
main();
