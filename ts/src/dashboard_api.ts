// Dashboard API Server
// Provides endpoints for viewing collected data and analysis results

import {
    getDb,
    getCollectionStats,
    getPatternStats,
    getBtcPriceHistory,
    getCompletedWindows,
    getStrategyComparison,
    getRecentTrades,
    getDailyPerformance
} from "./db";

const PORT = 3001;

// CORS headers for dashboard access
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
};

/**
 * Start the dashboard API server
 */
export function startDashboardApi() {
    console.log(`🌐 Starting Dashboard API on port ${PORT}...`);

    Bun.serve({
        port: PORT,
        async fetch(req) {
            const url = new URL(req.url);
            const path = url.pathname;

            // Handle CORS preflight
            if (req.method === "OPTIONS") {
                return new Response(null, { headers: corsHeaders });
            }

            try {
                // Route handlers
                if (path === "/api/data/stats") {
                    return await handleStats();
                }

                if (path === "/api/data/btc-prices") {
                    const hours = parseInt(url.searchParams.get("hours") || "24");
                    return await handleBtcPrices(hours);
                }

                if (path === "/api/data/patterns") {
                    const marketType = url.searchParams.get("type") || "15-MIN";
                    return await handlePatterns(marketType);
                }

                if (path === "/api/data/windows") {
                    const marketType = url.searchParams.get("type") || "15-MIN";
                    const days = parseInt(url.searchParams.get("days") || "7");
                    return await handleWindows(marketType, days);
                }

                if (path === "/api/data/signals") {
                    const hours = parseInt(url.searchParams.get("hours") || "24");
                    return await handleSignals(hours);
                }

                if (path === "/api/data/summary") {
                    return await handleSummary();
                }

                // Strategy comparison endpoints
                if (path === "/api/strategies") {
                    const days = parseInt(url.searchParams.get("days") || "7");
                    return await handleStrategies(days);
                }

                if (path === "/api/trades") {
                    const strategy = url.searchParams.get("strategy") || "latency";
                    const limit = parseInt(url.searchParams.get("limit") || "50");
                    return await handleTrades(strategy, limit);
                }

                if (path === "/api/performance") {
                    const strategy = url.searchParams.get("strategy") || "latency";
                    const days = parseInt(url.searchParams.get("days") || "7");
                    return await handlePerformance(strategy, days);
                }

                // 404 for unknown routes
                return new Response(JSON.stringify({ error: "Not found" }), {
                    status: 404,
                    headers: corsHeaders
                });

            } catch (error) {
                console.error("API Error:", error);
                return new Response(JSON.stringify({ error: "Internal server error" }), {
                    status: 500,
                    headers: corsHeaders
                });
            }
        }
    });

    console.log(`✅ Dashboard API running at http://localhost:${PORT}`);
    console.log(`   Endpoints:`);
    console.log(`   - GET /api/data/stats - Collection statistics`);
    console.log(`   - GET /api/data/btc-prices?hours=24 - BTC price history`);
    console.log(`   - GET /api/data/patterns?type=15-MIN - Pattern analysis results`);
    console.log(`   - GET /api/data/windows?type=15-MIN&days=7 - Completed windows`);
    console.log(`   - GET /api/data/signals?hours=24 - Recent trading signals`);
    console.log(`   - GET /api/data/summary - Full data summary`);
}

/**
 * Handle /api/data/stats
 */
async function handleStats(): Promise<Response> {
    const stats = await getCollectionStats();

    return new Response(JSON.stringify({
        btc_ticks: stats.btc_ticks,
        market_windows: stats.market_windows,
        completed_windows: stats.completed_windows,
        share_snapshots: stats.share_snapshots,
        oldest_data: stats.oldest_data?.toISOString() || null,
        newest_data: stats.newest_data?.toISOString() || null,
        data_span_days: stats.oldest_data && stats.newest_data
            ? (stats.newest_data.getTime() - stats.oldest_data.getTime()) / (1000 * 60 * 60 * 24)
            : 0
    }), { headers: corsHeaders });
}

/**
 * Handle /api/data/btc-prices
 */
async function handleBtcPrices(hours: number): Promise<Response> {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

    // Use larger intervals for longer time ranges
    const intervalSeconds = hours <= 1 ? 5 : hours <= 6 ? 30 : hours <= 24 ? 60 : 300;

    const prices = await getBtcPriceHistory(startTime, endTime, intervalSeconds);

    return new Response(JSON.stringify({
        hours,
        interval_seconds: intervalSeconds,
        count: prices.length,
        prices: prices.map(p => ({
            price: p.price,
            timestamp: p.timestamp.toISOString()
        }))
    }), { headers: corsHeaders });
}

/**
 * Handle /api/data/patterns
 */
async function handlePatterns(marketType: string): Promise<Response> {
    const patterns = await getPatternStats(marketType);

    // Group by pattern name
    const grouped: Record<string, any[]> = {};
    for (const p of patterns) {
        if (!grouped[p.pattern_name]) grouped[p.pattern_name] = [];
        grouped[p.pattern_name].push({
            minute_bucket: p.minute_bucket,
            sample_count: p.sample_count,
            win_rate: p.win_rate,
            reversal_probability: p.reversal_probability
        });
    }

    return new Response(JSON.stringify({
        market_type: marketType,
        pattern_count: patterns.length,
        patterns: grouped
    }), { headers: corsHeaders });
}

/**
 * Handle /api/data/windows
 */
async function handleWindows(marketType: string, days: number): Promise<Response> {
    const windows = await getCompletedWindows(marketType, days);

    // Calculate statistics
    const upWins = windows.filter(w => w.outcome === "UP").length;
    const downWins = windows.filter(w => w.outcome === "DOWN").length;

    return new Response(JSON.stringify({
        market_type: marketType,
        days,
        total_windows: windows.length,
        up_wins: upWins,
        down_wins: downWins,
        up_win_rate: windows.length > 0 ? upWins / windows.length : 0,
        windows: windows.slice(0, 100).map(w => ({
            id: w.id,
            asset: w.asset,
            window_start: w.window_start.toISOString(),
            window_end: w.window_end.toISOString(),
            strike_price: w.strike_price,
            outcome: w.outcome
        }))
    }), { headers: corsHeaders });
}

/**
 * Handle /api/data/signals
 */
async function handleSignals(hours: number): Promise<Response> {
    const sql = getDb();
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    const signals = await sql`
        SELECT
            ts.id,
            ts.signal_type,
            ts.direction,
            ts.confidence,
            ts.reason,
            ts.btc_price,
            ts.share_price,
            ts.minutes_remaining,
            ts.created_at,
            mw.asset,
            mw.market_type
        FROM trading_signals ts
        JOIN market_windows mw ON ts.window_id = mw.id
        WHERE ts.created_at > ${cutoff}
        ORDER BY ts.created_at DESC
        LIMIT 100
    `;

    return new Response(JSON.stringify({
        hours,
        count: signals.length,
        signals: signals.map(s => ({
            id: s.id,
            asset: s.asset,
            market_type: s.market_type,
            signal_type: s.signal_type,
            direction: s.direction,
            confidence: parseFloat(s.confidence),
            reason: s.reason,
            btc_price: parseFloat(s.btc_price),
            share_price: parseFloat(s.share_price),
            minutes_remaining: s.minutes_remaining,
            created_at: new Date(s.created_at).toISOString()
        }))
    }), { headers: corsHeaders });
}

/**
 * Handle /api/data/summary - Full data summary for dashboard
 */
async function handleSummary(): Promise<Response> {
    const stats = await getCollectionStats();

    // Get pattern summaries
    const patterns15 = await getPatternStats("15-MIN");
    const patterns60 = await getPatternStats("60-MIN");

    // Get recent windows
    const windows15 = await getCompletedWindows("15-MIN", 7);
    const windows60 = await getCompletedWindows("60-MIN", 7);

    // Calculate win rates
    const calcWinRate = (windows: any[]) => {
        if (windows.length === 0) return { total: 0, up: 0, down: 0, upRate: 0 };
        const up = windows.filter(w => w.outcome === "UP").length;
        return {
            total: windows.length,
            up,
            down: windows.length - up,
            upRate: up / windows.length
        };
    };

    return new Response(JSON.stringify({
        collection: {
            btc_ticks: stats.btc_ticks,
            market_windows: stats.market_windows,
            completed_windows: stats.completed_windows,
            share_snapshots: stats.share_snapshots,
            data_span_days: stats.oldest_data && stats.newest_data
                ? (stats.newest_data.getTime() - stats.oldest_data.getTime()) / (1000 * 60 * 60 * 24)
                : 0
        },
        patterns: {
            "15-MIN": {
                count: patterns15.length,
                hasData: patterns15.length > 0
            },
            "60-MIN": {
                count: patterns60.length,
                hasData: patterns60.length > 0
            }
        },
        windows: {
            "15-MIN": calcWinRate(windows15),
            "60-MIN": calcWinRate(windows60)
        },
        status: {
            ready: stats.completed_windows >= 20,
            message: stats.completed_windows >= 20
                ? "Sufficient data for pattern analysis"
                : `Need ${20 - stats.completed_windows} more completed windows for analysis`
        }
    }), { headers: corsHeaders });
}

/**
 * Handle /api/strategies - Strategy comparison stats
 */
async function handleStrategies(days: number): Promise<Response> {
    try {
        const comparison = await getStrategyComparison(days);
        
        return new Response(JSON.stringify({
            days,
            momentum: {
                trades: comparison.momentum.trades,
                wins: comparison.momentum.wins,
                pnl: comparison.momentum.pnl,
                winRate: comparison.momentum.winRate
            },
            latency: {
                trades: comparison.latency.trades,
                wins: comparison.latency.wins,
                pnl: comparison.latency.pnl,
                winRate: comparison.latency.winRate
            }
        }), { headers: corsHeaders });
    } catch (error) {
        console.error("Strategy comparison error:", error);
        return new Response(JSON.stringify({
            days,
            momentum: { trades: 0, wins: 0, pnl: 0, winRate: 0 },
            latency: { trades: 0, wins: 0, pnl: 0, winRate: 0 }
        }), { headers: corsHeaders });
    }
}

/**
 * Handle /api/trades - Recent trades for a strategy
 */
async function handleTrades(strategy: string, limit: number): Promise<Response> {
    try {
        const trades = await getRecentTrades(strategy, limit);
        
        return new Response(JSON.stringify({
            strategy,
            count: trades.length,
            trades: trades.map(t => ({
                id: t.id,
                asset: t.asset,
                marketType: t.marketType,
                direction: t.direction,
                entryPrice: t.entryPrice,
                exitPrice: t.exitPrice,
                expectedEdge: t.expectedEdge,
                realizedPnl: t.realizedPnl,
                outcome: t.outcome,
                entryTime: t.entryTime.toISOString()
            }))
        }), { headers: corsHeaders });
    } catch (error) {
        console.error("Trades fetch error:", error);
        return new Response(JSON.stringify({
            strategy,
            count: 0,
            trades: []
        }), { headers: corsHeaders });
    }
}

/**
 * Handle /api/performance - Daily performance for a strategy
 */
async function handlePerformance(strategy: string, days: number): Promise<Response> {
    try {
        const performance = await getDailyPerformance(strategy, days);
        
        return new Response(JSON.stringify({
            strategy,
            days,
            performance: performance.map(p => ({
                date: p.date.toISOString().split('T')[0],
                trades: p.trades,
                wins: p.wins,
                losses: p.losses,
                pnl: p.pnl,
                winRate: p.winRate
            }))
        }), { headers: corsHeaders });
    } catch (error) {
        console.error("Performance fetch error:", error);
        return new Response(JSON.stringify({
            strategy,
            days,
            performance: []
        }), { headers: corsHeaders });
    }
}

// Run if executed directly
if (import.meta.main) {
    startDashboardApi();

    // Keep alive
    setInterval(() => {}, 60000);
}
