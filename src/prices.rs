//! Polymarket price fetching module
//! Fetches orderbook data and share prices from the CLOB API

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

/// Configuration constants
pub const MAX_ENTRY_PRICE: f64 = 0.65;      // Don't buy shares above $0.65
pub const MIN_UPSIDE: f64 = 0.30;           // Require at least 30% potential upside
pub const MAX_SPREAD: f64 = 0.10;           // Max bid-ask spread to accept
const PRICE_CACHE_TTL_SECS: u64 = 5;        // Cache prices for 5 seconds
const CLOB_BASE_URL: &str = "https://clob.polymarket.com";

/// Market prices for a single market (Up and Down tokens)
#[derive(Debug, Clone)]
pub struct MarketPrices {
    pub up_price: f64,      // Mid price for Up token
    pub down_price: f64,    // Mid price for Down token
    pub up_bid: f64,        // Best bid for Up
    pub up_ask: f64,        // Best ask for Up
    pub down_bid: f64,      // Best bid for Down
    pub down_ask: f64,      // Best ask for Down
    pub timestamp: Instant,
}

/// Orderbook response from CLOB API
#[derive(Debug, Deserialize)]
struct OrderbookResponse {
    #[allow(dead_code)]
    market: Option<String>,
    #[allow(dead_code)]
    asset_id: Option<String>,
    bids: Vec<OrderbookLevel>,
    asks: Vec<OrderbookLevel>,
}

#[derive(Debug, Deserialize)]
struct OrderbookLevel {
    price: String,
    #[allow(dead_code)]
    size: String,
}

/// Cache for market prices
pub type PriceCache = Arc<RwLock<HashMap<String, (MarketPrices, Instant)>>>;

/// Create a new price cache
pub fn new_price_cache() -> PriceCache {
    Arc::new(RwLock::new(HashMap::new()))
}

/// Fetch the orderbook for a token and return best bid/ask
pub async fn fetch_orderbook(token_id: &str) -> Option<(f64, f64)> {
    let url = format!("{}/book?token_id={}", CLOB_BASE_URL, token_id);
    
    match reqwest::get(&url).await {
        Ok(response) => {
            if !response.status().is_success() {
                eprintln!("⚠️ Orderbook fetch failed for {}...: {}", 
                    &token_id[..20.min(token_id.len())], response.status());
                return None;
            }
            
            match response.json::<OrderbookResponse>().await {
                Ok(data) => {
                    let best_bid = data.bids.first()
                        .and_then(|b| b.price.parse::<f64>().ok())
                        .unwrap_or(0.0);
                    let best_ask = data.asks.first()
                        .and_then(|a| a.price.parse::<f64>().ok())
                        .unwrap_or(1.0);
                    
                    Some((best_bid, best_ask))
                }
                Err(e) => {
                    eprintln!("❌ Failed to parse orderbook: {}", e);
                    None
                }
            }
        }
        Err(e) => {
            eprintln!("❌ Failed to fetch orderbook: {}", e);
            None
        }
    }
}

/// Fetch prices for both Up and Down tokens of a market
pub async fn fetch_market_prices(
    up_token_id: &str,
    down_token_id: &str,
    cache: &PriceCache,
) -> Option<MarketPrices> {
    let cache_key = format!("{}-{}", up_token_id, down_token_id);
    
    // Check cache first
    if let Ok(cache_read) = cache.read() {
        if let Some((prices, cached_at)) = cache_read.get(&cache_key) {
            if cached_at.elapsed() < Duration::from_secs(PRICE_CACHE_TTL_SECS) {
                return Some(prices.clone());
            }
        }
    }
    
    // Fetch fresh prices
    let (up_result, down_result) = tokio::join!(
        fetch_orderbook(up_token_id),
        fetch_orderbook(down_token_id)
    );
    
    let (up_bid, up_ask) = up_result?;
    let (down_bid, down_ask) = down_result?;
    
    let prices = MarketPrices {
        up_price: (up_bid + up_ask) / 2.0,
        down_price: (down_bid + down_ask) / 2.0,
        up_bid,
        up_ask,
        down_bid,
        down_ask,
        timestamp: Instant::now(),
    };
    
    // Update cache
    if let Ok(mut cache_write) = cache.write() {
        cache_write.insert(cache_key, (prices.clone(), Instant::now()));
    }
    
    Some(prices)
}

/// Calculate bid-ask spread
pub fn calculate_spread(bid: f64, ask: f64) -> f64 {
    if bid <= 0.0 {
        return 1.0; // 100% spread if no bids
    }
    (ask - bid) / bid
}

/// Calculate potential upside from current price
/// If price is 0.40, upside is (1.0 - 0.40) / 0.40 = 150%
pub fn calculate_upside(price: f64) -> f64 {
    if price <= 0.0 || price >= 1.0 {
        return 0.0;
    }
    (1.0 - price) / price
}

/// Check if a trade opportunity passes value filters
pub fn passes_value_filters(
    entry_price: f64,
    bid: f64,
    ask: f64,
) -> Result<(f64, f64), &'static str> {
    // Check entry price
    if entry_price > MAX_ENTRY_PRICE {
        return Err("price too high");
    }
    
    // Check upside
    let upside = calculate_upside(entry_price);
    if upside < MIN_UPSIDE {
        return Err("upside too low");
    }
    
    // Check spread
    let spread = calculate_spread(bid, ask);
    if spread > MAX_SPREAD {
        return Err("spread too wide");
    }
    
    Ok((upside, spread))
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_calculate_upside() {
        assert!((calculate_upside(0.40) - 1.5).abs() < 0.01); // 150%
        assert!((calculate_upside(0.50) - 1.0).abs() < 0.01); // 100%
        assert!((calculate_upside(0.65) - 0.538).abs() < 0.01); // ~54%
    }
    
    #[test]
    fn test_calculate_spread() {
        assert!((calculate_spread(0.40, 0.45) - 0.125).abs() < 0.01); // 12.5%
        assert!((calculate_spread(0.50, 0.52) - 0.04).abs() < 0.01); // 4%
    }
    
    #[test]
    fn test_passes_value_filters() {
        // Good opportunity
        assert!(passes_value_filters(0.40, 0.38, 0.42).is_ok());
        
        // Price too high
        assert!(passes_value_filters(0.70, 0.68, 0.72).is_err());
        
        // Spread too wide
        assert!(passes_value_filters(0.40, 0.30, 0.50).is_err());
    }
}
