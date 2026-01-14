import { ClobClient } from "@polymarket/clob-client";
import type { Market } from "./types";

// Assets we trade on
const TRADEABLE_ASSETS = ["bitcoin", "ethereum", "solana"] as const;
type Asset = typeof TRADEABLE_ASSETS[number];

// Market timeframe types
type MarketTimeframe = "15M" | "hourly" | "daily";

interface GammaEvent {
    id: string;
    slug: string;
    title: string;
    markets: GammaMarket[];
}

interface GammaMarket {
    id: string;
    question: string;
    conditionId: string;
    questionID?: string;
    slug: string;
    outcomes: string;
    outcomePrices: string;
    clobTokenIds: string;
    endDate?: string;
    endDateIso?: string;
    active: boolean;
    closed: boolean;
}

/**
 * Generate the daily "Up or Down" market slug for a given asset and date
 * Pattern: {asset}-up-or-down-on-{month}-{day}
 * Example: bitcoin-up-or-down-on-january-14
 */
function generateDailySlug(asset: Asset, date: Date): string {
    const months = [
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december"
    ];
    
    const month = months[date.getMonth()];
    const day = date.getDate();
    
    return `${asset}-up-or-down-on-${month}-${day}`;
}

/**
 * Generate the next day's market slug (for pre-positioning)
 */
function generateNextDaySlug(asset: Asset): string {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return generateDailySlug(asset, tomorrow);
}

/**
 * Fetch a specific market by its slug from the Gamma API
 */
async function fetchMarketBySlug(slug: string): Promise<Market | null> {
    try {
        const response = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
        const markets = await response.json() as GammaMarket[];
        
        if (!markets || markets.length === 0) {
            return null;
        }
        
        const market = markets[0]!;
        
        // Skip closed markets
        if (market.closed) {
            return null;
        }
        
        // Parse token IDs
        let tokenIds: string[] = [];
        if (market.clobTokenIds) {
            try {
                tokenIds = JSON.parse(market.clobTokenIds);
            } catch (e) {
                console.error(`Failed to parse clobTokenIds for ${slug}:`, e);
                return null;
            }
        }
        
        if (tokenIds.length !== 2) {
            return null;
        }
        
        // Parse outcomes
        let outcomes: string[] = [];
        if (market.outcomes) {
            try {
                outcomes = JSON.parse(market.outcomes);
            } catch (e) {
                outcomes = ["Up", "Down"];
            }
        }
        
        // Determine asset from slug
        let asset = "BTC";
        if (slug.includes("ethereum")) {
            asset = "ETH";
        } else if (slug.includes("solana")) {
            asset = "SOL";
        }
        
        return {
            condition_id: market.conditionId,
            question_id: market.questionID || market.id,
            token_ids: tokenIds,
            outcomes: outcomes,
            end_date_iso: market.endDate || market.endDateIso || "",
            market_type: "DAILY",
            asset: asset
        };
    } catch (e) {
        console.error(`Failed to fetch market ${slug}:`, e);
        return null;
    }
}

/**
 * Fetch hourly markets using the series_slug API (more reliable for hourly markets)
 */
async function fetchHourlyMarketsBySeries(): Promise<Market[]> {
    const markets: Market[] = [];
    
    // Series slugs for hourly "Up or Down" markets
    const hourlySeriesSlugs = [
        { slug: "btc-up-or-down-hourly", asset: "BTC" },
        { slug: "eth-up-or-down-hourly", asset: "ETH" },
        { slug: "sol-up-or-down-hourly", asset: "SOL" },
    ];
    
    for (const { slug: seriesSlug, asset } of hourlySeriesSlugs) {
        try {
            const url = `https://gamma-api.polymarket.com/events?limit=5&active=true&closed=false&series_slug=${seriesSlug}`;
            console.log(`   📊 Fetching ${asset} hourly markets from series: ${seriesSlug}`);
            
            const response = await fetch(url);
            const events = await response.json() as GammaEvent[];
            
            for (const event of events) {
                if (!event.markets) continue;
                
                for (const market of event.markets) {
                    if (market.closed) continue;
                    
                    // Parse token IDs
                    let tokenIds: string[] = [];
                    if (market.clobTokenIds) {
                        try {
                            tokenIds = JSON.parse(market.clobTokenIds);
                        } catch (e) {
                            continue;
                        }
                    }
                    
                    if (tokenIds.length !== 2) continue;
                    
                    // Parse outcomes
                    let outcomes: string[] = [];
                    if (market.outcomes) {
                        try {
                            outcomes = JSON.parse(market.outcomes);
                        } catch (e) {
                            outcomes = ["Up", "Down"];
                        }
                    }
                    
                    markets.push({
                        condition_id: market.conditionId,
                        question_id: market.questionID || market.id,
                        token_ids: tokenIds,
                        outcomes: outcomes,
                        end_date_iso: market.endDate || market.endDateIso || "",
                        market_type: "60-MIN",
                        asset: asset
                    });
                    
                    console.log(`   ✅ Found ${asset} hourly: ${market.question?.slice(0, 50)}...`);
                }
            }
        } catch (e) {
            console.log(`   ⚠️ Could not fetch ${asset} hourly series: ${e}`);
        }
    }
    
    return markets;
}

/**
 * Fetch markets from a specific category page (15M, hourly, etc.)
 */
async function fetchCategoryMarkets(category: MarketTimeframe): Promise<Market[]> {
    const markets: Market[] = [];
    
    // For hourly markets, use the series_slug API which is more reliable
    if (category === "hourly") {
        return fetchHourlyMarketsBySeries();
    }
    
    try {
        // Fetch events for the category - the Gamma API doesn't have a direct category filter,
        // so we'll filter client-side based on question patterns
        const response = await fetch("https://gamma-api.polymarket.com/events?limit=100&active=true&closed=false&tag=crypto-prices");
        const events = await response.json() as GammaEvent[];
        
        for (const event of events) {
            if (!event.markets) continue;
            
            for (const market of event.markets) {
                if (market.closed) continue;
                
                const question = (market.question || "").toLowerCase();
                
                // Check if this is a crypto market
                const isBtc = question.includes("bitcoin") || question.includes("btc");
                const isEth = question.includes("ethereum") || question.includes("eth");
                const isSol = question.includes("solana") || question.includes("sol");
                
                if (!isBtc && !isEth && !isSol) continue;
                
                // Check timeframe based on category
                let matchesTimeframe = false;
                let marketType: "15-MIN" | "60-MIN" | "DAILY" = "15-MIN";
                
                if (category === "15M") {
                    matchesTimeframe = question.includes("15") || question.includes("fifteen");
                    marketType = "15-MIN";
                } else if (category === "daily") {
                    matchesTimeframe = question.includes("up or down") && 
                                       (question.includes("january") || question.includes("february") ||
                                        question.includes("march") || question.includes("april") ||
                                        question.includes("may") || question.includes("june") ||
                                        question.includes("july") || question.includes("august") ||
                                        question.includes("september") || question.includes("october") ||
                                        question.includes("november") || question.includes("december"));
                    marketType = "DAILY";
                }
                
                if (!matchesTimeframe) continue;
                
                // Parse token IDs
                let tokenIds: string[] = [];
                if (market.clobTokenIds) {
                    try {
                        tokenIds = JSON.parse(market.clobTokenIds);
                    } catch (e) {
                        continue;
                    }
                }
                
                if (tokenIds.length !== 2) continue;
                
                // Parse outcomes
                let outcomes: string[] = [];
                if (market.outcomes) {
                    try {
                        outcomes = JSON.parse(market.outcomes);
                    } catch (e) {
                        outcomes = ["Up", "Down"];
                    }
                }
                
                markets.push({
                    condition_id: market.conditionId,
                    question_id: market.questionID || market.id,
                    token_ids: tokenIds,
                    outcomes: outcomes,
                    end_date_iso: market.endDate || market.endDateIso || "",
                    market_type: marketType,
                    asset: isBtc ? "BTC" : isEth ? "ETH" : "SOL"
                });
            }
        }
    } catch (e) {
        console.error(`Failed to fetch ${category} markets:`, e);
    }
    
    return markets;
}

/**
 * Main market update function - fetches daily crypto markets using correct slugs
 */
export async function updateMarkets(client: ClobClient): Promise<Market[]> {
    console.log("🔎 Fetching daily crypto markets using specific slugs...");
    
    const newMarkets: Market[] = [];
    const today = new Date();
    
    // Fetch today's daily "Up or Down" markets for each asset
    for (const asset of TRADEABLE_ASSETS) {
        const todaySlug = generateDailySlug(asset, today);
        console.log(`   📊 Fetching ${asset} daily market: ${todaySlug}`);
        
        const market = await fetchMarketBySlug(todaySlug);
        if (market) {
            newMarkets.push(market);
            console.log(`   ✅ Found ${asset.toUpperCase()} daily: ${market.question_id}`);
            console.log(`      Token IDs: [${market.token_ids[0]?.slice(0, 20) ?? "?"}..., ${market.token_ids[1]?.slice(0, 20) ?? "?"}...]`);
            console.log(`      Outcomes: ${market.outcomes.join(", ")}`);
        } else {
            console.log(`   ⚠️ ${asset} daily market not found or closed`);
        }
    }
    
    // Also fetch 15-minute and hourly markets if available
    console.log("   📊 Fetching 15-minute and hourly crypto markets...");
    const shortTermMarkets = await fetchCategoryMarkets("15M");
    const hourlyMarkets = await fetchCategoryMarkets("hourly");
    
    newMarkets.push(...shortTermMarkets);
    newMarkets.push(...hourlyMarkets);
    
    console.log(`✅ Updated Market Cache: ${newMarkets.length} markets found`);
    
    // Log summary by asset
    const byAsset = newMarkets.reduce((acc, m) => {
        acc[m.asset] = (acc[m.asset] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);
    
    for (const [asset, count] of Object.entries(byAsset)) {
        console.log(`   ${asset}: ${count} markets`);
    }
    
    return newMarkets;
}

/**
 * Get today's daily market for a specific asset
 */
export async function getTodaysDailyMarket(asset: "bitcoin" | "ethereum" | "solana"): Promise<Market | null> {
    const today = new Date();
    const slug = generateDailySlug(asset, today);
    return fetchMarketBySlug(slug);
}

/**
 * Get tomorrow's daily market for a specific asset (for pre-positioning)
 */
export async function getTomorrowsDailyMarket(asset: "bitcoin" | "ethereum" | "solana"): Promise<Market | null> {
    const slug = generateNextDaySlug(asset);
    return fetchMarketBySlug(slug);
}
