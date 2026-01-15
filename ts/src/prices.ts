import { CONFIG } from "./config";

export interface MarketPrices {
    up_price: number;      // Current "Up" share price (mid)
    down_price: number;    // Current "Down" share price (mid)
    up_bid: number;        // Best bid for Up
    up_ask: number;        // Best ask for Up
    down_bid: number;      // Best bid for Down
    down_ask: number;      // Best ask for Down
    timestamp: number;     // When prices were fetched
}

interface OrderbookResponse {
    market: string;
    asset_id: string;
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
}

interface PriceResponse {
    price: string;
}

// Simple cache to avoid hammering the API
const priceCache = new Map<string, { data: MarketPrices; expiry: number }>();

/**
 * Fetch the current price for a single token
 */
export async function getTokenPrice(tokenId: string): Promise<number | null> {
    try {
        const url = `${CONFIG.POLYMARKET_CLOB_URL}/price?token_id=${tokenId}&side=buy`;
        const response = await fetch(url);
        
        if (!response.ok) {
            console.warn(`⚠️ Price fetch failed for ${tokenId.slice(0, 20)}...: ${response.status}`);
            return null;
        }
        
        const data = await response.json() as PriceResponse;
        return parseFloat(data.price);
    } catch (e) {
        console.error(`❌ Error fetching price for ${tokenId.slice(0, 20)}...:`, e);
        return null;
    }
}

/**
 * Fetch the orderbook for a token and extract best bid/ask
 */
export async function getOrderbook(tokenId: string): Promise<{ bid: number; ask: number } | null> {
    try {
        const url = `${CONFIG.POLYMARKET_CLOB_URL}/book?token_id=${tokenId}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            console.warn(`⚠️ Orderbook fetch failed for ${tokenId.slice(0, 20)}...: ${response.status}`);
            return null;
        }
        
        const data = await response.json() as OrderbookResponse;
        
        // Best bid is highest bid, best ask is lowest ask
        const bestBid = data.bids.length > 0 ? parseFloat(data.bids[0]!.price) : 0;
        const bestAsk = data.asks.length > 0 ? parseFloat(data.asks[0]!.price) : 1;
        
        return { bid: bestBid, ask: bestAsk };
    } catch (e) {
        console.error(`❌ Error fetching orderbook for ${tokenId.slice(0, 20)}...:`, e);
        return null;
    }
}

/**
 * Fetch prices for both Up and Down outcomes of a market
 * Uses caching to avoid excessive API calls
 */
export async function getMarketPrices(
    upTokenId: string, 
    downTokenId: string
): Promise<MarketPrices | null> {
    const cacheKey = `${upTokenId}-${downTokenId}`;
    const now = Date.now();
    
    // Check cache
    const cached = priceCache.get(cacheKey);
    if (cached && cached.expiry > now) {
        return cached.data;
    }
    
    try {
        // Fetch orderbooks for both tokens in parallel
        const [upBook, downBook] = await Promise.all([
            getOrderbook(upTokenId),
            getOrderbook(downTokenId)
        ]);
        
        if (!upBook || !downBook) {
            return null;
        }
        
        // Calculate mid prices
        const upMid = (upBook.bid + upBook.ask) / 2;
        const downMid = (downBook.bid + downBook.ask) / 2;
        
        const prices: MarketPrices = {
            up_price: upMid,
            down_price: downMid,
            up_bid: upBook.bid,
            up_ask: upBook.ask,
            down_bid: downBook.bid,
            down_ask: downBook.ask,
            timestamp: now
        };
        
        // Cache the result
        priceCache.set(cacheKey, {
            data: prices,
            expiry: now + (CONFIG.PRICE_CACHE_TTL_MS || 5000)
        });
        
        return prices;
    } catch (e) {
        console.error("❌ Error fetching market prices:", e);
        return null;
    }
}

/**
 * Calculate the spread for a token
 */
export function calculateSpread(bid: number, ask: number): number {
    if (bid === 0) return 1; // 100% spread if no bids
    return (ask - bid) / bid;
}

/**
 * Calculate potential upside from current price
 * If price is 0.40, upside is (1.0 - 0.40) / 0.40 = 150%
 */
export function calculateUpside(price: number): number {
    if (price <= 0 || price >= 1) return 0;
    return (1.0 - price) / price;
}
