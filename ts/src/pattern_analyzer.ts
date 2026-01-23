// Pattern Analysis Engine
// Analyzes collected data to find optimal entry/exit patterns

import {
    getDb,
    getCompletedWindows,
    getWindowSharePrices,
    getBtcPriceHistory,
    upsertPatternStats,
    getPatternStats,
    getCollectionStats
} from "./db";

// Analysis result types
interface WindowAnalysis {
    windowId: number;
    asset: string;
    marketType: string;
    strikePrice: number;
    outcome: string;
    btcPrices: Array<{ minute: number; price: number; vsStrike: number }>;
    sharePrices: Array<{ minute: number; upMid: number; downMid: number }>;
    earlyMomentum: number;      // Price change in first 3 minutes
    midMomentum: number;        // Price change from minute 3-10
    lateMomentum: number;       // Price change in last 5 minutes
    maxUpPrice: number;         // Highest UP share price
    maxDownPrice: number;       // Highest DOWN share price
    crossedStrike: boolean;     // Did BTC cross the strike price?
    crossedStrikeMinute: number | null;
}

interface PatternResult {
    patternName: string;
    marketType: string;
    minuteBucket: number | null;
    sampleCount: number;
    winRate: number;
    avgProfit: number;
    reversalProbability: number;
    description: string;
}

/**
 * Run full pattern analysis on collected data
 */
export async function analyzePatterns(days: number = 7): Promise<PatternResult[]> {
    console.log("=".repeat(60));
    console.log("🔬 PATTERN ANALYSIS ENGINE");
    console.log("=".repeat(60));

    const stats = await getCollectionStats();
    console.log(`\n📊 Analyzing ${stats.completed_windows} completed windows from last ${days} days`);

    const results: PatternResult[] = [];

    // Analyze both market types
    for (const marketType of ["15-MIN", "60-MIN"]) {
        console.log(`\n📈 Analyzing ${marketType} markets...`);

        const windows = await getCompletedWindows(marketType, days);
        console.log(`   Found ${windows.length} completed windows`);

        if (windows.length < 10) {
            console.log(`   ⚠️ Need at least 10 windows for analysis, skipping`);
            continue;
        }

        // Analyze each window
        const analyses: WindowAnalysis[] = [];
        for (const window of windows) {
            const analysis = await analyzeWindow(window, marketType);
            if (analysis) {
                analyses.push(analysis);
            }
        }

        console.log(`   Analyzed ${analyses.length} windows with complete data`);

        // Run pattern analyses
        const patterns = await runPatternAnalyses(analyses, marketType);
        results.push(...patterns);

        // Save patterns to database
        for (const pattern of patterns) {
            await upsertPatternStats(
                pattern.marketType,
                pattern.patternName,
                pattern.minuteBucket,
                pattern.sampleCount,
                pattern.winRate,
                pattern.reversalProbability,
                { avgProfit: pattern.avgProfit, description: pattern.description }
            );
        }
    }

    console.log(`\n✅ Analysis complete. Found ${results.length} patterns.`);
    return results;
}

/**
 * Analyze a single market window
 */
async function analyzeWindow(
    window: { id: number; asset: string; window_start: Date; window_end: Date; strike_price: number; outcome: string },
    marketType: string
): Promise<WindowAnalysis | null> {
    // Get share prices for this window
    const sharePrices = await getWindowSharePrices(window.id);
    if (sharePrices.length < 5) return null; // Need sufficient data

    // Get BTC prices for this window
    const btcPrices = await getBtcPriceHistory(
        window.window_start,
        window.window_end,
        10 // 10 second intervals
    );
    if (btcPrices.length < 10) return null;

    // Calculate BTC price by minute
    const duration = marketType === "15-MIN" ? 15 : 60;
    const btcByMinute: Array<{ minute: number; price: number; vsStrike: number }> = [];

    for (let minute = 0; minute < duration; minute++) {
        const targetTime = new Date(window.window_start.getTime() + minute * 60000);
        const closest = btcPrices.reduce((prev, curr) =>
            Math.abs(curr.timestamp.getTime() - targetTime.getTime()) <
            Math.abs(prev.timestamp.getTime() - targetTime.getTime()) ? curr : prev
        );
        btcByMinute.push({
            minute,
            price: closest.price,
            vsStrike: (closest.price - window.strike_price) / window.strike_price * 100
        });
    }

    // Calculate share prices by minute
    const shareByMinute = sharePrices.map(s => ({
        minute: s.minutes_elapsed,
        upMid: (s.up_bid + s.up_ask) / 2,
        downMid: (s.down_bid + s.down_ask) / 2
    }));

    // Calculate momentum metrics
    const earlyPrices = btcByMinute.filter(p => p.minute <= 3);
    const midPrices = btcByMinute.filter(p => p.minute > 3 && p.minute <= (duration - 5));
    const latePrices = btcByMinute.filter(p => p.minute > (duration - 5));

    const earlyMomentum = earlyPrices.length >= 2
        ? (earlyPrices[earlyPrices.length - 1].price - earlyPrices[0].price) / earlyPrices[0].price * 100
        : 0;

    const midMomentum = midPrices.length >= 2
        ? (midPrices[midPrices.length - 1].price - midPrices[0].price) / midPrices[0].price * 100
        : 0;

    const lateMomentum = latePrices.length >= 2
        ? (latePrices[latePrices.length - 1].price - latePrices[0].price) / latePrices[0].price * 100
        : 0;

    // Check if price crossed strike
    let crossedStrike = false;
    let crossedStrikeMinute: number | null = null;
    const startAboveStrike = btcByMinute[0].price >= window.strike_price;

    for (const bp of btcByMinute) {
        const nowAboveStrike = bp.price >= window.strike_price;
        if (nowAboveStrike !== startAboveStrike) {
            crossedStrike = true;
            crossedStrikeMinute = bp.minute;
            break;
        }
    }

    // Max share prices
    const maxUpPrice = Math.max(...shareByMinute.map(s => s.upMid));
    const maxDownPrice = Math.max(...shareByMinute.map(s => s.downMid));

    return {
        windowId: window.id,
        asset: window.asset,
        marketType,
        strikePrice: window.strike_price,
        outcome: window.outcome,
        btcPrices: btcByMinute,
        sharePrices: shareByMinute,
        earlyMomentum,
        midMomentum,
        lateMomentum,
        maxUpPrice,
        maxDownPrice,
        crossedStrike,
        crossedStrikeMinute
    };
}

/**
 * Run all pattern analyses on the windows
 */
async function runPatternAnalyses(analyses: WindowAnalysis[], marketType: string): Promise<PatternResult[]> {
    const results: PatternResult[] = [];
    const duration = marketType === "15-MIN" ? 15 : 60;

    // 1. Win rate by entry minute
    console.log("   📊 Analyzing win rate by entry minute...");
    for (let minute = 0; minute < duration - 2; minute++) {
        const relevant = analyses.filter(a => a.btcPrices.length > minute);
        if (relevant.length < 5) continue;

        // If you entered UP at this minute based on price above strike
        const upEntries = relevant.filter(a => a.btcPrices[minute].price >= a.strikePrice);
        const upWins = upEntries.filter(a => a.outcome === "UP").length;
        const upWinRate = upEntries.length > 0 ? upWins / upEntries.length : 0;

        // If you entered DOWN at this minute based on price below strike
        const downEntries = relevant.filter(a => a.btcPrices[minute].price < a.strikePrice);
        const downWins = downEntries.filter(a => a.outcome === "DOWN").length;
        const downWinRate = downEntries.length > 0 ? downWins / downEntries.length : 0;

        results.push({
            patternName: "entry_up_when_above_strike",
            marketType,
            minuteBucket: minute,
            sampleCount: upEntries.length,
            winRate: upWinRate,
            avgProfit: 0,
            reversalProbability: 1 - upWinRate,
            description: `Win rate for UP entry at minute ${minute} when price above strike`
        });

        results.push({
            patternName: "entry_down_when_below_strike",
            marketType,
            minuteBucket: minute,
            sampleCount: downEntries.length,
            winRate: downWinRate,
            avgProfit: 0,
            reversalProbability: 1 - downWinRate,
            description: `Win rate for DOWN entry at minute ${minute} when price below strike`
        });
    }

    // 2. Early momentum continuation pattern
    console.log("   📊 Analyzing early momentum patterns...");
    const strongEarlyUp = analyses.filter(a => a.earlyMomentum > 0.05); // >0.05% early move
    const strongEarlyDown = analyses.filter(a => a.earlyMomentum < -0.05);

    if (strongEarlyUp.length >= 5) {
        const continued = strongEarlyUp.filter(a => a.outcome === "UP").length;
        results.push({
            patternName: "early_momentum_up_continuation",
            marketType,
            minuteBucket: null,
            sampleCount: strongEarlyUp.length,
            winRate: continued / strongEarlyUp.length,
            avgProfit: 0,
            reversalProbability: 1 - (continued / strongEarlyUp.length),
            description: "When early momentum is UP (>0.05% in first 3 min), probability it continues"
        });
    }

    if (strongEarlyDown.length >= 5) {
        const continued = strongEarlyDown.filter(a => a.outcome === "DOWN").length;
        results.push({
            patternName: "early_momentum_down_continuation",
            marketType,
            minuteBucket: null,
            sampleCount: strongEarlyDown.length,
            winRate: continued / strongEarlyDown.length,
            avgProfit: 0,
            reversalProbability: 1 - (continued / strongEarlyDown.length),
            description: "When early momentum is DOWN (<-0.05% in first 3 min), probability it continues"
        });
    }

    // 3. Late reversal pattern
    console.log("   📊 Analyzing late reversal patterns...");
    const crossedLate = analyses.filter(a =>
        a.crossedStrike &&
        a.crossedStrikeMinute !== null &&
        a.crossedStrikeMinute > (duration - 5)
    );

    if (crossedLate.length >= 5) {
        // When price crosses strike late, does it stay there?
        const stayedAfterCross = crossedLate.filter(a => {
            const crossedUp = a.btcPrices[0].price < a.strikePrice; // Started below, crossed up
            return crossedUp ? a.outcome === "UP" : a.outcome === "DOWN";
        }).length;

        results.push({
            patternName: "late_cross_holds",
            marketType,
            minuteBucket: null,
            sampleCount: crossedLate.length,
            winRate: stayedAfterCross / crossedLate.length,
            avgProfit: 0,
            reversalProbability: 1 - (stayedAfterCross / crossedLate.length),
            description: "When price crosses strike in final 5 minutes, probability it holds"
        });
    }

    // 4. Share price profit-taking levels
    console.log("   📊 Analyzing optimal profit-taking levels...");
    for (const threshold of [0.70, 0.75, 0.80, 0.85]) {
        // When UP share hits threshold, what happens?
        const hitThreshold = analyses.filter(a => a.maxUpPrice >= threshold);
        if (hitThreshold.length >= 5) {
            const stillWonUp = hitThreshold.filter(a => a.outcome === "UP").length;
            results.push({
                patternName: `up_share_hits_${(threshold * 100).toFixed(0)}`,
                marketType,
                minuteBucket: null,
                sampleCount: hitThreshold.length,
                winRate: stillWonUp / hitThreshold.length,
                avgProfit: threshold - 0.50, // Approximate profit if sold at threshold
                reversalProbability: 1 - (stillWonUp / hitThreshold.length),
                description: `When UP share reaches ${(threshold * 100).toFixed(0)}c, probability UP still wins`
            });
        }
    }

    // 5. Overall baseline win rates
    console.log("   📊 Calculating baseline statistics...");
    const upWins = analyses.filter(a => a.outcome === "UP").length;
    results.push({
        patternName: "baseline_up_win_rate",
        marketType,
        minuteBucket: null,
        sampleCount: analyses.length,
        winRate: upWins / analyses.length,
        avgProfit: 0,
        reversalProbability: 1 - (upWins / analyses.length),
        description: "Baseline probability that UP wins (no signal)"
    });

    return results;
}

/**
 * Get actionable signals based on current market state
 */
export async function getSignals(
    marketType: string,
    currentMinute: number,
    btcPrice: number,
    strikePrice: number,
    upSharePrice: number,
    downSharePrice: number
): Promise<{
    action: "BUY_UP" | "BUY_DOWN" | "SELL" | "HOLD" | "FLIP";
    confidence: number;
    reason: string;
}> {
    const patterns = await getPatternStats(marketType);

    if (patterns.length === 0) {
        return { action: "HOLD", confidence: 0, reason: "No pattern data available yet" };
    }

    const priceVsStrike = btcPrice >= strikePrice ? "above" : "below";
    const duration = marketType === "15-MIN" ? 15 : 60;
    const minutesLeft = duration - currentMinute;

    // Check profit-taking signals
    if (upSharePrice >= 0.80) {
        const pattern = patterns.find(p => p.pattern_name === "up_share_hits_80");
        if (pattern && pattern.reversal_probability > 0.40) {
            return {
                action: "SELL",
                confidence: pattern.reversal_probability,
                reason: `UP share at ${(upSharePrice * 100).toFixed(0)}c with ${(pattern.reversal_probability * 100).toFixed(0)}% reversal risk`
            };
        }
    }

    if (downSharePrice >= 0.80) {
        const pattern = patterns.find(p => p.pattern_name === "down_share_hits_80");
        if (pattern && pattern.reversal_probability > 0.40) {
            return {
                action: "SELL",
                confidence: pattern.reversal_probability,
                reason: `DOWN share at ${(downSharePrice * 100).toFixed(0)}c with ${(pattern.reversal_probability * 100).toFixed(0)}% reversal risk`
            };
        }
    }

    // Check entry signals by minute
    const entryPattern = priceVsStrike === "above"
        ? patterns.find(p => p.pattern_name === "entry_up_when_above_strike" && p.minute_bucket === currentMinute)
        : patterns.find(p => p.pattern_name === "entry_down_when_below_strike" && p.minute_bucket === currentMinute);

    if (entryPattern && entryPattern.win_rate > 0.55 && entryPattern.sample_count >= 10) {
        return {
            action: priceVsStrike === "above" ? "BUY_UP" : "BUY_DOWN",
            confidence: entryPattern.win_rate,
            reason: `${(entryPattern.win_rate * 100).toFixed(0)}% win rate at minute ${currentMinute} when ${priceVsStrike} strike (n=${entryPattern.sample_count})`
        };
    }

    // Default to hold
    return {
        action: "HOLD",
        confidence: 0.5,
        reason: `No strong signal at minute ${currentMinute} (${minutesLeft} min left)`
    };
}

/**
 * Print analysis summary
 */
export async function printAnalysisSummary(): Promise<void> {
    console.log("\n" + "=".repeat(60));
    console.log("📊 PATTERN ANALYSIS SUMMARY");
    console.log("=".repeat(60));

    for (const marketType of ["15-MIN", "60-MIN"]) {
        const patterns = await getPatternStats(marketType);

        if (patterns.length === 0) {
            console.log(`\n${marketType}: No patterns found`);
            continue;
        }

        console.log(`\n${marketType} PATTERNS:`);
        console.log("-".repeat(40));

        // Group by pattern name
        const byPattern = patterns.reduce((acc, p) => {
            if (!acc[p.pattern_name]) acc[p.pattern_name] = [];
            acc[p.pattern_name].push(p);
            return acc;
        }, {} as Record<string, typeof patterns>);

        for (const [name, items] of Object.entries(byPattern)) {
            if (items[0].minute_bucket === null) {
                // Single value pattern
                const p = items[0];
                console.log(`\n   ${name}:`);
                console.log(`      Win rate: ${(p.win_rate * 100).toFixed(1)}%`);
                console.log(`      Reversal prob: ${(p.reversal_probability * 100).toFixed(1)}%`);
                console.log(`      Sample size: ${p.sample_count}`);
            } else {
                // Time-series pattern
                console.log(`\n   ${name}:`);
                const best = items.reduce((a, b) => a.win_rate > b.win_rate ? a : b);
                const worst = items.reduce((a, b) => a.win_rate < b.win_rate ? a : b);
                console.log(`      Best minute: ${best.minute_bucket} (${(best.win_rate * 100).toFixed(1)}% win rate)`);
                console.log(`      Worst minute: ${worst.minute_bucket} (${(worst.win_rate * 100).toFixed(1)}% win rate)`);
            }
        }
    }

    console.log("\n" + "=".repeat(60));
}

// Run analysis if executed directly
if (import.meta.main) {
    const days = parseInt(process.argv[2] || "7");
    analyzePatterns(days)
        .then(() => printAnalysisSummary())
        .catch(console.error);
}
