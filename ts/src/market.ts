// @ts-nocheck
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
    eventStartTime?: string;
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
 * Generate an hourly "Up or Down" market slug for a given asset, date, and hour
 * Pattern: {asset}-up-or-down-{month}-{day}-{hour}am/pm-et
 * Example: bitcoin-up-or-down-january-16-9am-et
 */
function generateHourlySlug(asset: Asset, date: Date, hourET: number): string {
    const months = [
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december"
    ];

    const month = months[date.getMonth()];
    const day = date.getDate();

    // Convert 24h to 12h format with am/pm
    let hourStr: string;
    if (hourET === 0) {
        hourStr = "12am";
    } else if (hourET === 12) {
        hourStr = "12pm";
    } else if (hourET < 12) {
        hourStr = `${hourET}am`;
    } else {
        hourStr = `${hourET - 12}pm`;
    }

    return `${asset}-up-or-down-${month}-${day}-${hourStr}-et`;
}

/**
 * Get the current hour in ET (Eastern Time)
 */
function getCurrentHourET(): { date: Date; hour: number } {
    const now = new Date();
    // Create a formatter for ET
    const etFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false
    });

    const parts = etFormatter.formatToParts(now);
    const year = parseInt(parts.find(p => p.type === 'year')?.value || '2026');
    const month = parseInt(parts.find(p => p.type === 'month')?.value || '1') - 1;
    const day = parseInt(parts.find(p => p.type === 'day')?.value || '1');
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');

    return {
        date: new Date(year, month, day),
        hour: hour
    };
}

/**
 * Generate a 15-minute market slug
 * Pattern: {asset}-updown-15m-{unix_timestamp}
 * Where asset = btc, eth, sol and timestamp is the START of the 15-min window in UTC
 */
function generate15MinSlug(asset: Asset, startTimestamp: number): string {
    const assetShort = asset === "bitcoin" ? "btc" : asset === "ethereum" ? "eth" : "sol";
    return `${assetShort}-updown-15m-${startTimestamp}`;
}

/**
 * Get the current and upcoming 15-minute window timestamps
 * Returns timestamps aligned to 15-minute boundaries (00, 15, 30, 45)
 */
function get15MinWindowTimestamps(count: number = 4): number[] {
    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();

    // Find the start of the current 15-min window
    const windowStart = currentMinute - (currentMinute % 15);

    // Create a date for the current window start
    const windowDate = new Date(now);
    windowDate.setUTCMinutes(windowStart, 0, 0);

    const timestamps: number[] = [];
    for (let i = 0; i < count; i++) {
        const ts = Math.floor(windowDate.getTime() / 1000) + (i * 15 * 60);
        timestamps.push(ts);
    }

    return timestamps;
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
        
        let strikePrice: number | null = null;
        if (market.eventStartTime) {
            strikePrice = await fetchBinanceOpenPrice(asset, market.eventStartTime);
        }
        
        // Fallback to question parsing if Binance fetch fails (or for testing)
        if (!strikePrice) {
            strikePrice = extractStrikePrice(market.question);
        }

        return {
            condition_id: market.conditionId,
            question_id: market.questionID || market.id,
            token_ids: tokenIds,
            outcomes: outcomes,
            end_date_iso: market.endDate || market.endDateIso || "",
            market_type: "DAILY",
            asset: asset,
            strike_price: strikePrice
        };
    } catch (e) {
        console.error(`Failed to fetch market ${slug}:`, e);
        return null;
    }
}

/**
 * Fetch a single 15-minute market by its event slug from the Gamma API
 * Note: 15-minute markets use CHAINLINK for resolution, not Binance!
 */
async function fetch15MinEventBySlug(slug: string, asset: string): Promise<Market | null> {
    try {
        const url = `https://gamma-api.polymarket.com/events?slug=${slug}`;
        const response = await fetch(url);
        const events = await response.json() as GammaEvent[];

        if (!events || events.length === 0) {
            return null;
        }

        const event = events[0]!;
        if (!event.markets || event.markets.length === 0) {
            return null;
        }

        const market = event.markets[0]!;

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

        // For 15-min markets, strike price comes from Chainlink at eventStartTime
        // We'll try to parse it from question or fetch from Chainlink
        let strikePrice: number | null = null;
        if (market.eventStartTime) {
            // Try Chainlink price (15-min markets use Chainlink, not Binance)
            strikePrice = await fetchChainlinkPrice(asset, market.eventStartTime);
        }
        if (!strikePrice) {
            strikePrice = extractStrikePrice(market.question || "");
        }

        return {
            condition_id: market.conditionId,
            question_id: market.questionID || market.id,
            token_ids: tokenIds,
            outcomes: outcomes,
            end_date_iso: market.endDate || market.endDateIso || "",
            market_type: "15-MIN",
            asset: asset,
            strike_price: strikePrice
        };
    } catch (e) {
        return null;
    }
}

/**
 * Fetch 15-minute markets by generating slugs for current and upcoming windows
 */
async function fetch15MinMarketsBySlug(): Promise<Market[]> {
    const markets: Market[] = [];
    const timestamps = get15MinWindowTimestamps(4); // Current + next 3 windows

    console.log(`   📊 Fetching 15-minute markets for ${timestamps.length} time windows...`);

    for (const asset of TRADEABLE_ASSETS) {
        const assetSymbol = asset === "bitcoin" ? "BTC" : asset === "ethereum" ? "ETH" : "SOL";

        for (const ts of timestamps) {
            const slug = generate15MinSlug(asset, ts);
            const windowTime = new Date(ts * 1000).toISOString();

            const market = await fetch15MinEventBySlug(slug, assetSymbol);
            if (market) {
                markets.push(market);
                console.log(`   ✅ Found ${assetSymbol} 15-min: ${windowTime}`);
                console.log(`      Strike Price: $${market.strike_price} | Ends: ${market.end_date_iso}`);
            }
        }
    }

    return markets;
}

/**
 * Fetch Chainlink price for a specific timestamp
 * Used for 15-minute markets which use Chainlink for resolution
 * Falls back to Binance 15m candles as approximation (difference is usually < 0.1%)
 */
async function fetchChainlinkPrice(symbol: string, isoTime: string): Promise<number | null> {
    // Chainlink doesn't have a simple historical price API like Binance
    // Use Binance 15m candles as approximation
    return fetchBinancePrice(symbol, isoTime, "15m");
}

/**
 * Fetch Binance price for a specific timestamp with configurable interval
 */
async function fetchBinancePrice(symbol: string, isoTime: string, interval: "15m" | "1h"): Promise<number | null> {
    try {
        const startTime = new Date(isoTime).getTime();
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&startTime=${startTime}&limit=1`;

        const response = await fetch(url);
        if (!response.ok) return null;

        const data = await response.json() as any[];
        if (data && data.length > 0) {
            // Candle format: [openTime, open, high, low, close, ...]
            return parseFloat(data[0][1]);
        }
    } catch (e) {
        // Silently fail - strike price will be null
    }
    return null;
}

/**
 * Fetch a single hourly market by its event slug from the Gamma API
 */
async function fetchHourlyEventBySlug(slug: string, asset: string): Promise<Market | null> {
    try {
        const url = `https://gamma-api.polymarket.com/events?slug=${slug}`;
        const response = await fetch(url);
        const events = await response.json() as GammaEvent[];

        if (!events || events.length === 0) {
            return null;
        }

        const event = events[0]!;
        if (!event.markets || event.markets.length === 0) {
            return null;
        }

        const market = event.markets[0]!;

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

        // Fetch strike price from Binance using eventStartTime
        let strikePrice: number | null = null;
        if (market.eventStartTime) {
            strikePrice = await fetchBinanceOpenPrice(asset, market.eventStartTime);
        }
        if (!strikePrice) {
            strikePrice = extractStrikePrice(market.question || "");
        }

        return {
            condition_id: market.conditionId,
            question_id: market.questionID || market.id,
            token_ids: tokenIds,
            outcomes: outcomes,
            end_date_iso: market.endDate || market.endDateIso || "",
            market_type: "60-MIN",
            asset: asset,
            strike_price: strikePrice
        };
    } catch (e) {
        // Silently fail for non-existent markets
        return null;
    }
}

/**
 * Fetch hourly markets by generating slugs for current and upcoming hours
 * Fetches current hour + next 2 hours of markets for each asset
 */
async function fetchHourlyMarketsBySlug(): Promise<Market[]> {
    const markets: Market[] = [];
    const { date, hour } = getCurrentHourET();

    console.log(`   📊 Current time in ET: ${hour}:00 on ${date.toDateString()}`);

    // Fetch current hour and next 2 hours for each asset
    const hoursToFetch = [hour, hour + 1, hour + 2];

    for (const asset of TRADEABLE_ASSETS) {
        const assetSymbol = asset === "bitcoin" ? "BTC" : asset === "ethereum" ? "ETH" : "SOL";

        for (const h of hoursToFetch) {
            // Handle day rollover
            let fetchDate = date;
            let fetchHour = h;
            if (h >= 24) {
                fetchHour = h - 24;
                fetchDate = new Date(date);
                fetchDate.setDate(fetchDate.getDate() + 1);
            }

            const slug = generateHourlySlug(asset, fetchDate, fetchHour);
            console.log(`   📊 Fetching ${assetSymbol} hourly: ${slug}`);

            const market = await fetchHourlyEventBySlug(slug, assetSymbol);
            if (market) {
                markets.push(market);
                console.log(`   ✅ Found ${assetSymbol} hourly: ${market.question_id.slice(0, 30)}...`);
                console.log(`      Strike Price: $${market.strike_price} | Ends: ${market.end_date_iso}`);
            }
        }
    }

    return markets;
}

/**
 * Fetch markets from a specific category (15M or hourly)
 */
async function fetchCategoryMarkets(category: MarketTimeframe): Promise<Market[]> {
    if (category === "hourly") {
        return fetchHourlyMarketsBySlug();
    }

    if (category === "15M") {
        return fetch15MinMarketsBySlug();
    }

    // Daily markets not supported (use fetchMarketBySlug with daily slugs if needed)
    return [];
}

/**
 * Extract strike price from market question
 * Example: "Will Bitcoin be above $95,412.25 on Jan 17?" -> 95412.25
 */
function extractStrikePrice(question: string): number | null {
    // Regex to find currency amount: $ followed by numbers, optional commas, optional decimals
    const priceRegex = /\$([\d,]+(?:\.\d+)?)/;
    const match = question.match(priceRegex);
    
    if (match && match[1]) {
        // Remove commas and parse
        const cleanPrice = match[1].replace(/,/g, '');
        const price = parseFloat(cleanPrice);
        return isNaN(price) ? null : price;
    }
    
    return null;
}

/**
 * Fetch Binance Open Price for a specific timestamp (1H candle)
 * Used to determine the "Price to Beat" (Strike Price) for hourly markets
 */
async function fetchBinanceOpenPrice(symbol: string, isoTime: string): Promise<number | null> {
    return fetchBinancePrice(symbol, isoTime, "1h");
}

/**
 * Main market update function - fetches 15-minute and hourly crypto markets
 * Note: 15-min markets use Chainlink for resolution, hourly markets use Binance
 */
export async function updateMarkets(client: ClobClient): Promise<Market[]> {
    console.log("🔎 Fetching 15-minute and hourly crypto markets...");

    const newMarkets: Market[] = [];

    // Fetch 15-minute markets (uses Chainlink for resolution)
    console.log("\n📊 15-MINUTE MARKETS (Chainlink):");
    const shortTermMarkets = await fetchCategoryMarkets("15M");
    newMarkets.push(...shortTermMarkets);

    // Fetch hourly markets (uses Binance for resolution)
    console.log("\n📊 HOURLY MARKETS (Binance):");
    const hourlyMarkets = await fetchCategoryMarkets("hourly");
    newMarkets.push(...hourlyMarkets);

    console.log(`\n✅ Updated Market Cache: ${newMarkets.length} markets found`);

    // Log summary by market type and asset
    const by15Min = newMarkets.filter(m => m.market_type === "15-MIN");
    const byHourly = newMarkets.filter(m => m.market_type === "60-MIN");

    console.log(`   15-min markets: ${by15Min.length} (BTC: ${by15Min.filter(m => m.asset === "BTC").length}, ETH: ${by15Min.filter(m => m.asset === "ETH").length}, SOL: ${by15Min.filter(m => m.asset === "SOL").length})`);
    console.log(`   Hourly markets: ${byHourly.length} (BTC: ${byHourly.filter(m => m.asset === "BTC").length}, ETH: ${byHourly.filter(m => m.asset === "ETH").length}, SOL: ${byHourly.filter(m => m.asset === "SOL").length})`);

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

/**
 * Re-fetch strike prices for markets that are missing them
 * This is useful for markets that just started and haven't had their strike price set yet
 * Polymarket typically sets the strike price 1-2 minutes after the market window starts
 */
export async function refetchMissingStrikePrices(markets: Market[]): Promise<Market[]> {
    const marketsWithMissingPrices = markets.filter(m => !m.strike_price);

    if (marketsWithMissingPrices.length === 0) {
        return markets; // All markets have strike prices
    }

    console.log(`🔄 Re-fetching strike prices for ${marketsWithMissingPrices.length} markets...`);

    const updatedMarkets = [...markets];
    let updatedCount = 0;

    for (let i = 0; i < updatedMarkets.length; i++) {
        const market = updatedMarkets[i]!;

        if (market.strike_price) {
            continue; // Already has strike price
        }

        // Try to fetch the strike price based on market type
        let newStrikePrice: number | null = null;

        if (market.market_type === "15-MIN") {
            // 15-min markets: Try to get Chainlink/Binance 15m price
            // We need to find the eventStartTime - reconstruct from end_date
            const endDate = new Date(market.end_date_iso);
            const startDate = new Date(endDate.getTime() - 15 * 60 * 1000); // 15 mins before end
            newStrikePrice = await fetchChainlinkPrice(market.asset, startDate.toISOString());
        } else if (market.market_type === "60-MIN") {
            // Hourly markets: Try to get Binance 1H price
            const endDate = new Date(market.end_date_iso);
            const startDate = new Date(endDate.getTime() - 60 * 60 * 1000); // 1 hour before end
            newStrikePrice = await fetchBinanceOpenPrice(market.asset, startDate.toISOString());
        }

        if (newStrikePrice) {
            updatedMarkets[i] = { ...market, strike_price: newStrikePrice };
            updatedCount++;
            console.log(`   ✅ Updated ${market.asset} ${market.market_type}: strike price = $${newStrikePrice.toFixed(2)}`);
        }
    }

    if (updatedCount > 0) {
        console.log(`   📊 Updated ${updatedCount} strike prices`);
    } else {
        console.log(`   ℹ️ No new strike prices available yet`);
    }

    return updatedMarkets;
}

/**
 * Get count of markets missing strike prices
 */
export function countMissingStrikePrices(markets: Market[]): number {
    return markets.filter(m => !m.strike_price).length;
}
