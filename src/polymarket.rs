// use alloy_signer::Signer;
// use alloy_signer_local::PrivateKeySigner;
// use alloy_signer::Signer;
use alloy_signer_local::PrivateKeySigner;
use polymarket_rs::client::{ClobClient, GammaClient, TradingClient};
use polymarket_rs::types::{
    ApiCreds, CreateOrderOptions, OrderArgs, Side as PolySide, OrderType,
};
use polymarket_rs::OrderBuilder;
use rust_decimal::prelude::*;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, RwLock};
use tokio::time::{interval, Duration};

/// Cached market data for strategy and execution
#[derive(Debug, Clone)]
pub struct CachedMarket {
    pub asset: String,       // "BTC", "ETH", etc.
    pub market_type: String, // "15-MIN", "60-MIN"
    pub condition_id: String,
    pub question_id: String,
    pub token_ids: Vec<String>, // [YES_ID, NO_ID]
    pub outcomes: Vec<String>,  // ["Up", "Down"]
    pub end_date_iso: String,   // ISO timestamp for expiry
}

pub type MarketCache = Arc<RwLock<HashMap<String, Vec<CachedMarket>>>>;

/// Order side
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum OrderSide {
    BUY,
    SELL,
}

impl OrderSide {
    pub fn as_str(&self) -> &str {
        match self {
            OrderSide::BUY => "BUY",
            OrderSide::SELL => "SELL",
        }
    }
}

/// Polymarket CLOB Client wrapper
pub struct PolymarketClient {
    gamma: GammaClient,
    clob: ClobClient,
    trading: TradingClient,
    pub address: String,
}

impl PolymarketClient {
    /// Create a new client from environment variables
    pub fn from_env() -> Option<Self> {
        let api_key = std::env::var("POLYMARKET_API_KEY").ok()?;
        let api_secret = std::env::var("POLYMARKET_API_SECRET").ok()?;
        let passphrase = std::env::var("POLYMARKET_PASSPHRASE").ok()?;
        let private_key = std::env::var("POLYMARKET_PRIVATE_KEY").ok()?;

        let wallet = PrivateKeySigner::from_str(&private_key).ok()?;
        let address = format!("{:?}", wallet.address());

        let chain_id = 137;
        let host = "https://clob.polymarket.com";
        let gamma_host = "https://gamma-api.polymarket.com";

        let gamma = GammaClient::new(gamma_host);
        let clob = ClobClient::new(host);

        let creds = ApiCreds {
            api_key,
            secret: api_secret,
            passphrase,
        };

        let builder = OrderBuilder::new(wallet.clone(), None, None);
        let trading = TradingClient::new(host, wallet, chain_id, creds, builder);

        Some(Self {
            gamma,
            clob,
            trading,
            address,
        })
    }

    pub async fn fetch_balance(&self) -> Result<f64, Box<dyn std::error::Error>> {
        // Placeholder
        Ok(0.0)
    }

    pub async fn place_order(
        &self,
        token_id: &str,
        side: OrderSide,
        size: f64,
        price: f64,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let poly_side = match side {
            OrderSide::BUY => PolySide::Buy,
            OrderSide::SELL => PolySide::Sell,
        };

        let price_dec = Decimal::from_f64(price).ok_or("Invalid price")?;
        let size_dec = Decimal::from_f64(size).ok_or("Invalid size")?;

        let args = OrderArgs {
            token_id: token_id.to_string(),
            price: price_dec,
            size: size_dec,
            side: poly_side,
        };

        let request = self
            .trading
            .create_order(&args, None, None, CreateOrderOptions::default())?;
            
        let resp = self.trading.post_order(request, OrderType::Gtc).await?;
        Ok(resp.order_id.to_string())
    }

    pub async fn start_market_cache_updater(
        _client: Arc<Self>,
        _cache: MarketCache,
        _assets: Vec<String>,
    ) {
        let mut interval = interval(Duration::from_secs(300));
        loop {
            interval.tick().await;
            println!("🔎 Updating Market Cache...");
            // ...
        }
    }
}
