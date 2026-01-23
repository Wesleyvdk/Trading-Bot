// Enhanced Trading Bot - V2 with Pattern Analysis
// Uses historical data patterns for optimal entry/exit decisions

import { CONFIG } from "./config";
import { initializeClient } from "./client";
import { updateMarkets, refetchMissingStrikePrices, countMissingStrikePrices } from "./market";
import { processPriceUpdateV2 } from "./strategy_v2";
import { startDataCollection, getCollectionStatus } from "./data_collector";
import { analyzePatterns, printAnalysisSummary } from "./pattern_analyzer";
import { getCollectionStats, initDataTables } from "./db";
import type { Market } from "./types";
import { AssetType } from "@polymarket/clob-client";

let markets: Market[] = [];

async function main() {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║           POLYMARKET TRADING BOT V2                          ║
║           Data-Driven Dynamic Strategy                       ║
╚══════════════════════════════════════════════════════════════╝
`);

    // Check command line args
    const args = process.argv.slice(2);
    const collectOnly = args.includes("--collect");
    const analyzeOnly = args.includes("--analyze");
    const skipCollection = args.includes("--no-collect");

    if (analyzeOnly) {
        console.log("🔬 Running pattern analysis only...\n");
        await analyzePatterns(14);
        await printAnalysisSummary();
        return;
    }

    // Initialize database tables
    await initDataTables();

    // Check existing data
    const stats = await getCollectionStats();
    const dataSpan = stats.oldest_data && stats.newest_data
        ? (stats.newest_data.getTime() - stats.oldest_data.getTime()) / (1000 * 60 * 60 * 24)
        : 0;

    console.log("📊 Database Status:");
    console.log(`   BTC ticks: ${stats.btc_ticks.toLocaleString()}`);
    console.log(`   Completed windows: ${stats.completed_windows}`);
    console.log(`   Data span: ${dataSpan.toFixed(1)} days`);

    if (dataSpan < 1) {
        console.log("\n⚠️  Less than 1 day of data collected.");
        console.log("   Pattern-based signals will use momentum fallback until more data is available.");
        console.log("   Run with --collect to start data collection.\n");
    }

    if (collectOnly) {
        console.log("\n📊 Starting data collection mode...\n");
        await startDataCollection();
        return;
    }

    // 1. Initialize Client
    console.log("\n🚀 Initializing trading client...");
    const client = await initializeClient();

    // 2. Fetch Initial Balance
    try {
        const balanceAllowance = await client.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL
        });
        const balanceRaw = parseFloat(balanceAllowance?.balance || "0");
        const balance = balanceRaw / 1_000_000;
        console.log(`💰 Initial Balance: $${balance.toFixed(2)}`);
    } catch (e) {
        console.error("⚠️ Could not fetch balance:", e);
    }

    // 3. Run pattern analysis if we have enough data
    if (stats.completed_windows >= 20) {
        console.log("\n🔬 Running pattern analysis...");
        await analyzePatterns(14);
    }

    // 4. Market Discovery
    console.log("\n🔎 Discovering Markets...");
    markets = await updateMarkets(client);

    // Full market refresh every 5 minutes
    setInterval(async () => {
        markets = await updateMarkets(client);
    }, 5 * 60 * 1000);

    // Re-fetch missing strike prices every 30 seconds
    setInterval(async () => {
        const missingCount = countMissingStrikePrices(markets);
        if (missingCount > 0) {
            markets = await refetchMissingStrikePrices(markets);
        }
    }, 30 * 1000);

    // 5. Start data collection in background (unless disabled)
    if (!skipCollection) {
        console.log("\n📊 Starting background data collection...");
        startDataCollection().catch(console.error);
    }

    // 6. Re-analyze patterns periodically (every 6 hours)
    setInterval(async () => {
        console.log("\n🔬 Periodic pattern re-analysis...");
        await analyzePatterns(14);
    }, 6 * 60 * 60 * 1000);

    // 7. Connect to Binance
    console.log(`\n🔌 Connecting to Binance WebSocket...`);
    const ws = new WebSocket(CONFIG.BINANCE_WS_URL);

    ws.onopen = () => {
        console.log("✅ Connected to Binance WebSocket");
        console.log("\n" + "=".repeat(50));
        console.log("🤖 V2 TRADING BOT ACTIVE");
        console.log("=".repeat(50) + "\n");
    };

    ws.onmessage = async (event) => {
        try {
            const msg = JSON.parse(event.data as string);
            const price = parseFloat(msg.p);
            const time = msg.T;

            await processPriceUpdateV2(price, time, client, markets);
        } catch (e) {
            // Ignore parse errors
        }
    };

    ws.onerror = (error) => {
        console.error("❌ WebSocket Error:", error);
    };

    ws.onclose = () => {
        console.log("⚠️ WebSocket closed, reconnecting in 5s...");
        setTimeout(() => {
            // Reconnect logic would go here
        }, 5000);
    };

    // Status logging every 5 minutes
    setInterval(() => {
        const collectionStatus = getCollectionStatus();
        console.log("\n📊 Status Update:");
        console.log(`   BTC Price: $${collectionStatus.latestBtcPrice.toFixed(2)}`);
        console.log(`   Active Markets: ${markets.filter(m => m.strike_price).length}/${markets.length}`);
        console.log(`   Data Collection: ${collectionStatus.btcTickCount} ticks, ${collectionStatus.shareSnapshotCount} snapshots`);
    }, 5 * 60 * 1000);
}

main().catch(console.error);
