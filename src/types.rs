// Shared types for the trading bot

use std::time::Instant;

/// Represents an open position
#[derive(Debug, Clone)]
pub struct Position {
    pub market_type: MarketType,
    pub side: Side,
    pub entry_price_cents: u64,  // e.g., 55 = $0.55
    pub size_dollars: u64,        // e.g., 10 = $10
    pub entry_time: Instant,
    pub market_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MarketType {
    Hourly,    // 60-minute market
    Fifteen,   // 15-minute market
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Side {
    Yes,
    No,
}

/// Price snapshot for momentum calculation
#[derive(Debug, Clone, Copy)]
pub struct PriceSnapshot {
    pub price_cents: u64,  // Binance price * 100
    pub timestamp_ms: u64,
}

impl PriceSnapshot {
    pub fn new(price_cents: u64, timestamp_ms: u64) -> Self {
        Self { price_cents, timestamp_ms }
    }
}
