// @ts-nocheck
import { updateMarkets, refetchMissingStrikePrices, countMissingStrikePrices } from "./market";
import { ClobClient } from "@polymarket/clob-client";
import * as dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function sanityCheck() {
    console.log("=".repeat(60));
    console.log("🔍 SANITY CHECK - Market & Strike Price Verification");
    console.log("=".repeat(60));

    // Mock client (not needed for market fetching)
    const client = {} as ClobClient;

    // Step 1: Fetch all markets
    console.log("\n📊 STEP 1: Initial Market Fetch");
    console.log("-".repeat(40));
    let markets = await updateMarkets(client);

    // Step 2: Analyze strike prices
    console.log("\n📊 STEP 2: Strike Price Analysis");
    console.log("-".repeat(40));

    const withStrike = markets.filter(m => m.strike_price !== null);
    const withoutStrike = markets.filter(m => m.strike_price === null);

    console.log(`\n✅ Markets WITH strike price (${withStrike.length}):`);
    for (const m of withStrike) {
        const timeLeft = getTimeLeft(m.end_date_iso);
        console.log(`   ${m.asset} ${m.market_type}: $${m.strike_price?.toFixed(2)} | Ends in ${timeLeft}`);
    }

    console.log(`\n⏳ Markets WITHOUT strike price (${withoutStrike.length}):`);
    for (const m of withoutStrike) {
        const timeLeft = getTimeLeft(m.end_date_iso);
        const startTime = getStartTime(m.end_date_iso, m.market_type);
        console.log(`   ${m.asset} ${m.market_type}: Starts ${startTime} | Ends in ${timeLeft}`);
    }

    // Step 3: Test re-fetch mechanism
    console.log("\n📊 STEP 3: Testing Re-fetch Mechanism");
    console.log("-".repeat(40));

    const missingBefore = countMissingStrikePrices(markets);
    console.log(`\nMissing strike prices before re-fetch: ${missingBefore}`);

    markets = await refetchMissingStrikePrices(markets);

    const missingAfter = countMissingStrikePrices(markets);
    console.log(`Missing strike prices after re-fetch: ${missingAfter}`);
    console.log(`Strike prices recovered: ${missingBefore - missingAfter}`);

    // Step 4: Tradeable markets summary
    console.log("\n📊 STEP 4: Tradeable Markets Summary");
    console.log("-".repeat(40));

    const tradeable = markets.filter(m => m.strike_price !== null);
    console.log(`\n🎯 TRADEABLE MARKETS (${tradeable.length} total):\n`);

    // Group by market type
    const by15Min = tradeable.filter(m => m.market_type === "15-MIN");
    const byHourly = tradeable.filter(m => m.market_type === "60-MIN");

    if (by15Min.length > 0) {
        console.log("   15-MINUTE MARKETS (Chainlink resolution):");
        for (const m of by15Min) {
            const timeLeft = getTimeLeft(m.end_date_iso);
            console.log(`      ${m.asset}: Strike $${m.strike_price?.toFixed(2)} | ${timeLeft} remaining`);
        }
    }

    if (byHourly.length > 0) {
        console.log("\n   HOURLY MARKETS (Binance resolution):");
        for (const m of byHourly) {
            const timeLeft = getTimeLeft(m.end_date_iso);
            console.log(`      ${m.asset}: Strike $${m.strike_price?.toFixed(2)} | ${timeLeft} remaining`);
        }
    }

    // Step 5: Strategy readiness check
    console.log("\n📊 STEP 5: Strategy Readiness Check");
    console.log("-".repeat(40));

    const checks = [
        { name: "Markets discovered", pass: markets.length > 0, value: `${markets.length} markets` },
        { name: "Tradeable markets available", pass: tradeable.length > 0, value: `${tradeable.length} tradeable` },
        { name: "15-min markets ready", pass: by15Min.length > 0, value: `${by15Min.length} ready` },
        { name: "Hourly markets ready", pass: byHourly.length > 0, value: `${byHourly.length} ready` },
        { name: "Strike prices fetched", pass: tradeable.length > 0, value: `${tradeable.length}/${markets.length} have prices` },
    ];

    console.log("");
    for (const check of checks) {
        const icon = check.pass ? "✅" : "❌";
        console.log(`   ${icon} ${check.name}: ${check.value}`);
    }

    const allPassed = checks.every(c => c.pass);
    console.log("\n" + "=".repeat(60));
    if (allPassed) {
        console.log("✅ SANITY CHECK PASSED - Bot is ready to trade!");
    } else {
        console.log("⚠️  SANITY CHECK WARNING - Some checks failed");
    }
    console.log("=".repeat(60));
}

function getTimeLeft(endDateIso: string): string {
    const end = new Date(endDateIso);
    const now = new Date();
    const diffMs = end.getTime() - now.getTime();

    if (diffMs < 0) return "EXPIRED";

    const mins = Math.floor(diffMs / 60000);
    const secs = Math.floor((diffMs % 60000) / 1000);

    if (mins > 60) {
        const hours = Math.floor(mins / 60);
        const remainMins = mins % 60;
        return `${hours}h ${remainMins}m`;
    }

    return `${mins}m ${secs}s`;
}

function getStartTime(endDateIso: string, marketType: string): string {
    const end = new Date(endDateIso);
    const durationMs = marketType === "15-MIN" ? 15 * 60 * 1000 : 60 * 60 * 1000;
    const start = new Date(end.getTime() - durationMs);
    const now = new Date();

    if (start <= now) {
        return "STARTED";
    }

    const diffMs = start.getTime() - now.getTime();
    const mins = Math.floor(diffMs / 60000);
    const secs = Math.floor((diffMs % 60000) / 1000);

    if (mins > 60) {
        const hours = Math.floor(mins / 60);
        const remainMins = mins % 60;
        return `in ${hours}h ${remainMins}m`;
    }

    return `in ${mins}m ${secs}s`;
}

sanityCheck().catch(console.error);
