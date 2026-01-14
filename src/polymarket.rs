use alloy_signer_local::PrivateKeySigner;
use polymarket_rs::client::{AuthenticatedClient, GammaClient, TradingClient};
use polymarket_rs::types::{
    ApiCreds, CreateOrderOptions, OrderArgs, Side as PolySide, OrderType,
    BalanceAllowanceParams, AssetType,
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
    authenticated: AuthenticatedClient,
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

        let creds = ApiCreds {
            api_key: api_key.clone(),
            secret: api_secret.clone(),
            passphrase: passphrase.clone(),
        };

        // Create authenticated client for balance queries
        let authenticated = AuthenticatedClient::new(
            host,
            wallet.clone(),
            chain_id,
            Some(creds.clone()),
            None, // No funder
        );

        let builder = OrderBuilder::new(wallet.clone(), None, None);
        let trading = TradingClient::new(host, wallet, chain_id, creds, builder);

        Some(Self {
            gamma,
            authenticated,
            trading,
            address,
        })
    }

    /// Fetch account balance using polymarket-rs AuthenticatedClient
    pub async fn fetch_balance(&self) -> Result<f64, Box<dyn std::error::Error>> {
        // Use get_balance_allowance with Collateral asset type (USDC)
        let params = BalanceAllowanceParams::new().asset_type(AssetType::Collateral);
        
        let response = self.authenticated.get_balance_allowance(params).await?;
        
        // Parse the balance from the JSON response
        // Response format is typically: {"balance": "...", "allowance": "..."}
        if let Some(balance_str) = response.get("balance").and_then(|b| b.as_str()) {
            // Balance is typically in USDC with 6 decimals
            if let Ok(balance_raw) = balance_str.parse::<f64>() {
                let balance = balance_raw / 1_000_000.0; // Convert from 6 decimals
                return Ok(balance);
            }
        }
        
        // Fallback: try parsing as number directly
        if let Some(balance) = response.get("balance").and_then(|b| b.as_f64()) {
            return Ok(balance / 1_000_000.0);
        }
        
        println!("⚠️ Could not parse balance from response: {:?}", response);
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

    /// Update market cache using GammaClient::get_events
    pub async fn start_market_cache_updater(
        client: Arc<Self>,
        cache: MarketCache,
        _assets: Vec<String>,
    ) {
        let mut interval = interval(Duration::from_secs(300));
        loop {
            interval.tick().await;
            println!("🔎 Updating Market Cache...");
            
            // Use GammaClient to fetch events
            match client.gamma.get_events().await {
                Ok(events) => {
                    let mut new_markets: HashMap<String, Vec<CachedMarket>> = HashMap::new();
                    let mut count = 0;
                    
                    for event in events {
                        // Check if event contains crypto-related markets
                        let _event_title = event.title.to_lowercase();
                        
                        // Process markets in this event
                        for market in &event.markets {
                            let question = market.question.to_lowercase();
                            
                            // Determine asset (BTC, ETH, SOL, XRP)
                            let asset = if question.contains("bitcoin") || question.contains("btc") {
                                "BTC"
                            } else if question.contains("ethereum") || question.contains("eth") {
                                "ETH"
                            } else if question.contains("solana") || question.contains("sol") {
                                "SOL"
                            } else if question.contains("xrp") || question.contains("ripple") {
                                "XRP"
                            } else {
                                continue; // Skip unknown assets
                            };
                            
                            // Determine market type
                            let market_type = if question.contains("15") || question.contains("fifteen") {
                                "15-MIN"
                            } else if question.contains("60") || question.contains("hour") {
                                "60-MIN"
                            } else {
                                "15-MIN" // Default
                            };
                            
                            // Get token IDs from clob_token_ids JSON string
                            let token_ids: Vec<String> = if let Some(ref ids_str) = market.clob_token_ids {
                                serde_json::from_str(ids_str).unwrap_or_default()
                            } else {
                                Vec::new()
                            };
                            
                            // Parse outcomes from JSON string
                            let outcomes: Vec<String> = if let Some(ref outcomes_str) = market.outcomes {
                                serde_json::from_str(outcomes_str).unwrap_or_default()
                            } else {
                                Vec::new()
                            };
                            
                            if token_ids.len() == 2 {
                                let cached_market = CachedMarket {
                                    asset: asset.to_string(),
                                    market_type: market_type.to_string(),
                                    condition_id: market.condition_id.clone(),
                                    question_id: market.id.clone(),
                                    token_ids,
                                    outcomes,
                                    end_date_iso: String::new(), // Not available in GammaMarket
                                };
                                
                                new_markets.entry(asset.to_string())
                                    .or_insert_with(Vec::new)
                                    .push(cached_market);
                                count += 1;
                            }
                        }
                    }
                    
                    // Update the cache
                    if let Ok(mut write_guard) = cache.write() {
                        *write_guard = new_markets;
                        println!("✅ Updated Market Cache: {} markets found", count);
                    } else {
                        eprintln!("❌ Failed to acquire write lock on market cache");
                    }
                }
                Err(e) => eprintln!("❌ Failed to fetch events from Gamma: {}", e),
            }
        }
    }
}

