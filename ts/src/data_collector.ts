// Data Collector Module
// Continuously collects BTC prices and Polymarket share prices for analysis

import {
    initDataTables,
    insertBtcPriceTick,
    upsertMarketWindow,
    insertSharePriceSnapshot,
    updateMarketOutcome,
    getCollectionStats
} from "./db";
import { updateMarkets } from "./market";
import { getMarketPrices } from "./prices";
import type { Market } from "./types";
import { ClobClient } from "@polymarket/clob-client";

// Collection state
let isCollecting = false;
let btcTickCount = 0;
let shareSnapshotCount = 0;
let activeWindows: Map<string, { windowId: number; market: Market; lastSnapshot: number }> = new Map();

// Configuration
const CONFIG = {
    BTC_SAVE_INTERVAL_MS: 5000,        // Save BTC price every 5 seconds
    SHARE_SNAPSHOT_INTERVAL_MS: 30000, // Snapshot share prices every 30 seconds
    MARKET_REFRESH_INTERVAL_MS: 60000, // Refresh market list every 1 minute
    STATS_LOG_INTERVAL_MS: 300000,     // Log stats every 5 minutes
    BINANCE_WS_URL: "wss://stream.binance.com:9443/ws/btcusdt@trade"
};

let latestBtcPrice: number = 0;
let lastBtcSaveTime: number = 0;

/**
 * Start the data collection process
 */
export async function startDataCollection(): Promise<void> {
    if (isCollecting) {
        console.log("⚠️ Data collection already running");
        return;
    }

    console.log("=".repeat(60));
    console.log("📊 STARTING DATA COLLECTION");
    console.log("=".repeat(60));

    // Initialize database tables
    await initDataTables();

    // Log initial stats
    const stats = await getCollectionStats();
    console.log("\n📈 Current Database Stats:");
    console.log(`   BTC price ticks: ${stats.btc_ticks.toLocaleString()}`);
    console.log(`   Market windows: ${stats.market_windows}`);
    console.log(`   Completed windows: ${stats.completed_windows}`);
    console.log(`   Share snapshots: ${stats.share_snapshots.toLocaleString()}`);
    if (stats.oldest_data) {
        console.log(`   Data range: ${stats.oldest_data.toISOString()} to ${stats.newest_data?.toISOString()}`);
    }

    isCollecting = true;

    // Start BTC price collection via WebSocket
    startBtcCollection();

    // Start market tracking and share price collection
    await startMarketTracking();

    // Periodic stats logging
    setInterval(async () => {
        await logCollectionStats();
    }, CONFIG.STATS_LOG_INTERVAL_MS);

    console.log("\n✅ Data collection started successfully");
    console.log(`   BTC prices: every ${CONFIG.BTC_SAVE_INTERVAL_MS / 1000}s`);
    console.log(`   Share prices: every ${CONFIG.SHARE_SNAPSHOT_INTERVAL_MS / 1000}s`);
    console.log(`   Market refresh: every ${CONFIG.MARKET_REFRESH_INTERVAL_MS / 1000}s`);
}

/**
 * Connect to Binance WebSocket and collect BTC prices
 */
function startBtcCollection(): void {
    console.log(`\n🔌 Connecting to Binance WebSocket...`);

    const ws = new WebSocket(CONFIG.BINANCE_WS_URL);

    ws.onopen = () => {
        console.log("✅ Connected to Binance WebSocket");
    };

    ws.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data as string);
            const price = parseFloat(data.p);
            const now = Date.now();

            latestBtcPrice = price;

            // Save to database at configured interval
            if (now - lastBtcSaveTime >= CONFIG.BTC_SAVE_INTERVAL_MS) {
                await insertBtcPriceTick(price);
                lastBtcSaveTime = now;
                btcTickCount++;

                // Log occasionally
                if (btcTickCount % 100 === 0) {
                    console.log(`[BTC] ${btcTickCount} ticks saved | Latest: $${price.toFixed(2)}`);
                }
            }
        } catch (e) {
            // Silently ignore parse errors
        }
    };

    ws.onerror = (error) => {
        console.error("❌ Binance WebSocket error:", error);
    };

    ws.onclose = () => {
        console.log("⚠️ Binance WebSocket closed, reconnecting in 5s...");
        setTimeout(startBtcCollection, 5000);
    };
}

/**
 * Track active markets and collect share prices
 */
async function startMarketTracking(): Promise<void> {
    console.log("\n📊 Starting market tracking...");

    // Mock client for market fetching
    const client = {} as ClobClient;

    // Initial market fetch
    let markets = await updateMarkets(client);
    await processMarkets(markets);

    // Refresh markets periodically
    setInterval(async () => {
        try {
            markets = await updateMarkets(client);
            await processMarkets(markets);
        } catch (e) {
            console.error("❌ Error refreshing markets:", e);
        }
    }, CONFIG.MARKET_REFRESH_INTERVAL_MS);

    // Collect share prices periodically
    setInterval(async () => {
        await collectSharePrices();
    }, CONFIG.SHARE_SNAPSHOT_INTERVAL_MS);
}

/**
 * Process markets and create/update window records
 */
async function processMarkets(markets: Market[]): Promise<void> {
    const now = new Date();

    for (const market of markets) {
        const windowKey = `${market.asset}-${market.market_type}-${market.end_date_iso}`;

        // Calculate window start from end date
        const windowEnd = new Date(market.end_date_iso);
        const durationMs = market.market_type === "15-MIN" ? 15 * 60 * 1000 : 60 * 60 * 1000;
        const windowStart = new Date(windowEnd.getTime() - durationMs);

        // Skip already-ended windows
        if (windowEnd <= now) {
            // Check if we need to record the outcome
            const existing = activeWindows.get(windowKey);
            if (existing && !existing.market.strike_price) {
                // Window ended, try to determine outcome
                await checkAndRecordOutcome(existing.windowId, existing.market);
                activeWindows.delete(windowKey);
            }
            continue;
        }

        // Create or update window in database
        if (!activeWindows.has(windowKey)) {
            try {
                const windowId = await upsertMarketWindow(
                    market.market_type,
                    market.asset,
                    windowStart,
                    windowEnd,
                    market.strike_price,
                    market.condition_id
                );

                activeWindows.set(windowKey, {
                    windowId,
                    market,
                    lastSnapshot: 0
                });

                console.log(`   📌 Tracking: ${market.asset} ${market.market_type} (window ${windowId})`);
            } catch (e) {
                // Ignore duplicate errors
            }
        } else {
            // Update strike price if it was null before
            const existing = activeWindows.get(windowKey)!;
            if (!existing.market.strike_price && market.strike_price) {
                existing.market.strike_price = market.strike_price;
                await upsertMarketWindow(
                    market.market_type,
                    market.asset,
                    windowStart,
                    windowEnd,
                    market.strike_price,
                    market.condition_id
                );
                console.log(`   📌 Updated strike price: ${market.asset} ${market.market_type} = $${market.strike_price}`);
            }
        }
    }
}

/**
 * Collect share prices for all active windows
 */
async function collectSharePrices(): Promise<void> {
    const now = new Date();

    for (const [key, window] of activeWindows) {
        const { windowId, market } = window;

        // Calculate minutes elapsed
        const windowEnd = new Date(market.end_date_iso);
        const durationMs = market.market_type === "15-MIN" ? 15 * 60 * 1000 : 60 * 60 * 1000;
        const windowStart = new Date(windowEnd.getTime() - durationMs);

        // Skip if window hasn't started yet
        if (now < windowStart) continue;

        // Skip if window has ended
        if (now >= windowEnd) {
            await checkAndRecordOutcome(windowId, market);
            activeWindows.delete(key);
            continue;
        }

        const minutesElapsed = Math.floor((now.getTime() - windowStart.getTime()) / 60000);

        // Fetch share prices
        try {
            const prices = await getMarketPrices(
                market.token_ids[0]!,
                market.token_ids[1]!
            );

            if (prices) {
                await insertSharePriceSnapshot(
                    windowId,
                    prices.up_bid,
                    prices.up_ask,
                    prices.down_bid,
                    prices.down_ask,
                    minutesElapsed
                );

                shareSnapshotCount++;
                window.lastSnapshot = minutesElapsed;
            }
        } catch (e) {
            // Silently ignore price fetch errors
        }
    }
}

/**
 * Check and record the outcome of a completed market window
 */
async function checkAndRecordOutcome(windowId: number, market: Market): Promise<void> {
    if (!market.strike_price) return;

    // Get BTC price at window end (use latest price as approximation)
    const finalPrice = latestBtcPrice;

    if (finalPrice > 0 && market.strike_price > 0) {
        const outcome = finalPrice >= market.strike_price ? "UP" : "DOWN";
        await updateMarketOutcome(windowId, outcome);
        console.log(`   ✅ Recorded outcome: ${market.asset} ${market.market_type} = ${outcome} (BTC: $${finalPrice.toFixed(2)} vs Strike: $${market.strike_price.toFixed(2)})`);
    }
}

/**
 * Log current collection statistics
 */
async function logCollectionStats(): Promise<void> {
    const stats = await getCollectionStats();

    console.log("\n" + "=".repeat(50));
    console.log("📊 DATA COLLECTION STATS");
    console.log("=".repeat(50));
    console.log(`   BTC ticks collected: ${stats.btc_ticks.toLocaleString()}`);
    console.log(`   Market windows: ${stats.market_windows} (${stats.completed_windows} completed)`);
    console.log(`   Share snapshots: ${stats.share_snapshots.toLocaleString()}`);
    console.log(`   Active windows: ${activeWindows.size}`);
    console.log(`   Session: ${btcTickCount} ticks, ${shareSnapshotCount} snapshots`);
    if (stats.oldest_data && stats.newest_data) {
        const days = (stats.newest_data.getTime() - stats.oldest_data.getTime()) / (1000 * 60 * 60 * 24);
        console.log(`   Data span: ${days.toFixed(1)} days`);
    }
    console.log("=".repeat(50) + "\n");
}

/**
 * Stop data collection
 */
export function stopDataCollection(): void {
    isCollecting = false;
    console.log("⏹️ Data collection stopped");
}

/**
 * Get current collection status
 */
export function getCollectionStatus(): {
    isCollecting: boolean;
    btcTickCount: number;
    shareSnapshotCount: number;
    activeWindows: number;
    latestBtcPrice: number;
} {
    return {
        isCollecting,
        btcTickCount,
        shareSnapshotCount,
        activeWindows: activeWindows.size,
        latestBtcPrice
    };
}

// Run if executed directly
if (import.meta.main) {
    startDataCollection().catch(console.error);
}
