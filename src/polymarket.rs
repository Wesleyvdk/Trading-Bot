use alloy_signer_local::PrivateKeySigner;
use chrono::Datelike;
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

        // For Magic.Link wallets, use the funder (proxy wallet) address
        let funder_address_str = std::env::var("POLYMARKET_FUNDER_ADDRESS").ok();
        let funder_address: Option<polymarket_rs::Address> = funder_address_str.as_ref().and_then(|s| {
            polymarket_rs::Address::from_str(s).ok()
        });
        if let Some(ref funder) = funder_address {
            println!("📝 Using Funder (Proxy) Address: {:?}", funder);
        }

        // Create authenticated client for balance queries
        let authenticated = AuthenticatedClient::new(
            host,
            wallet.clone(),
            chain_id,
            Some(creds.clone()),
            funder_address, // Funder address for Magic.Link wallets
        );

        // For Magic.Link, use SignatureType::PolyProxy (type 1) 
        let sig_type = if funder_address_str.is_some() {
            Some(polymarket_rs::types::SignatureType::PolyProxy)
        } else {
            None
        };
        let builder = OrderBuilder::new(wallet.clone(), sig_type, funder_address);
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
        
        // Debug: print the raw response
        println!("📊 Balance API response: {:?}", response);;
        
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
            println!("🔎 Updating Market Cache with daily crypto markets...");
            
            let mut new_markets: HashMap<String, Vec<CachedMarket>> = HashMap::new();
            let mut count = 0;
            
            // Get today's date for generating slugs
            let now = chrono::Utc::now();
            let month = match now.month() {
                1 => "january",
                2 => "february",
                3 => "march",
                4 => "april",
                5 => "may",
                6 => "june",
                7 => "july",
                8 => "august",
                9 => "september",
                10 => "october",
                11 => "november",
                12 => "december",
                _ => "january"
            };
            let day = now.day();
            
            // Fetch daily "Up or Down" markets for BTC, ETH, SOL
            let assets_to_fetch = vec![
                ("bitcoin", "BTC"),
                ("ethereum", "ETH"),
                ("solana", "SOL"),
            ];
            
            for (asset_slug, asset_symbol) in assets_to_fetch {
                // Generate the slug: e.g., "bitcoin-up-or-down-on-january-14"
                let slug = format!("{}-up-or-down-on-{}-{}", asset_slug, month, day);
                println!("   📊 Fetching {} daily: {}", asset_symbol, slug);
                
                // Fetch market by slug using the Gamma API directly
                let url = format!(
                    "https://gamma-api.polymarket.com/markets?slug={}",
                    slug
                );
                
                match reqwest::get(&url).await {
                    Ok(response) => {
                        if let Ok(markets) = response.json::<Vec<GammaMarketResponse>>().await {
                            if let Some(market) = markets.first() {
                                // Skip closed markets
                                if market.closed.unwrap_or(false) {
                                    println!("   ⚠️ {} daily market is closed", asset_symbol);
                                    continue;
                                }
                                
                                // Parse token IDs from JSON string
                                let token_ids: Vec<String> = market.clob_token_ids
                                    .as_ref()
                                    .and_then(|s| serde_json::from_str(s).ok())
                                    .unwrap_or_default();
                                
                                // Parse outcomes from JSON string
                                let outcomes: Vec<String> = market.outcomes
                                    .as_ref()
                                    .and_then(|s| serde_json::from_str(s).ok())
                                    .unwrap_or_else(|| vec!["Up".to_string(), "Down".to_string()]);
                                
                                if token_ids.len() == 2 {
                                    let cached_market = CachedMarket {
                                        asset: asset_symbol.to_string(),
                                        market_type: "DAILY".to_string(),
                                        condition_id: market.condition_id.clone(),
                                        question_id: market.id.clone(),
                                        token_ids: token_ids.clone(),
                                        outcomes,
                                        end_date_iso: market.end_date.clone().unwrap_or_default(),
                                    };
                                    
                                    println!("   ✅ Found {} daily: {}", asset_symbol, market.id);
                                    println!("      Token IDs: [{}, {}]", 
                                        &token_ids[0][..20.min(token_ids[0].len())],
                                        &token_ids[1][..20.min(token_ids[1].len())]);
                                    
                                    new_markets.entry(asset_symbol.to_string())
                                        .or_insert_with(Vec::new)
                                        .push(cached_market);
                                    count += 1;
                                }
                            } else {
                                println!("   ⚠️ {} daily market not found: {}", asset_symbol, slug);
                            }
                        }
                    }
                    Err(e) => eprintln!("   ❌ Failed to fetch {}: {}", slug, e),
                }
            }
            
            // Fetch hourly markets using series_slug API (more reliable)
            let hourly_series = vec![
                ("btc-up-or-down-hourly", "BTC"),
                ("eth-up-or-down-hourly", "ETH"),
                ("sol-up-or-down-hourly", "SOL"),
            ];
            
            for (series_slug, asset) in hourly_series {
                let url = format!(
                    "https://gamma-api.polymarket.com/events?limit=5&active=true&closed=false&series_slug={}",
                    series_slug
                );
                println!("   📊 Fetching {} hourly markets from series: {}", asset, series_slug);
                
                match reqwest::get(&url).await {
                    Ok(response) => {
                        if let Ok(events) = response.json::<Vec<serde_json::Value>>().await {
                            for event in events {
                                if let Some(markets) = event.get("markets").and_then(|m| m.as_array()) {
                                    for market in markets {
                                        // Check if closed
                                        let is_closed = market.get("closed")
                                            .and_then(|c| c.as_bool())
                                            .unwrap_or(false);
                                        if is_closed {
                                            continue;
                                        }
                                        
                                        // Get market data
                                        let condition_id = market.get("conditionId")
                                            .and_then(|c| c.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        let question_id = market.get("id")
                                            .and_then(|i| i.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        let question = market.get("question")
                                            .and_then(|q| q.as_str())
                                            .unwrap_or("");
                                        
                                        // Parse token IDs
                                        let token_ids: Vec<String> = market.get("clobTokenIds")
                                            .and_then(|t| t.as_str())
                                            .and_then(|s| serde_json::from_str(s).ok())
                                            .unwrap_or_default();
                                        
                                        // Parse outcomes
                                        let outcomes: Vec<String> = market.get("outcomes")
                                            .and_then(|o| o.as_str())
                                            .and_then(|s| serde_json::from_str(s).ok())
                                            .unwrap_or_else(|| vec!["Up".to_string(), "Down".to_string()]);
                                        
                                        let end_date = market.get("endDate")
                                            .and_then(|e| e.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        
                                        // FILTER: Only accept markets with "up or down" in the question
                                        // This filters out unrelated markets like "MicroStrategy" or "Trump deport"
                                        let question_lower = question.to_lowercase();
                                        let is_price_market = question_lower.contains("up or down") || 
                                                            question_lower.contains("up/down");
                                        
                                        if !is_price_market {
                                            // Skip non-price markets silently
                                            continue;
                                        }
                                        
                                        if token_ids.len() == 2 && !condition_id.is_empty() {
                                            let cached_market = CachedMarket {
                                                asset: asset.to_string(),
                                                market_type: "60-MIN".to_string(),
                                                condition_id,
                                                question_id: question_id.clone(),
                                                token_ids: token_ids.clone(),
                                                outcomes,
                                                end_date_iso: end_date,
                                            };
                                            
                                            println!("   ✅ Found {} hourly: {}...", 
                                                asset, 
                                                &question[..50.min(question.len())]);
                                            
                                            new_markets.entry(asset.to_string())
                                                .or_insert_with(Vec::new)
                                                .push(cached_market);
                                            count += 1;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => eprintln!("   ⚠️ Failed to fetch {} hourly series: {}", asset, e),
                }
            }
            
            // Update the cache
            if let Ok(mut write_guard) = cache.write() {
                // Log summary
                for (asset, markets) in &new_markets {
                    println!("   📈 {}: {} markets", asset, markets.len());
                }
                *write_guard = new_markets;
                println!("✅ Updated Market Cache: {} markets found", count);
            } else {
                eprintln!("❌ Failed to acquire write lock on market cache");
            }
        }
    }
}

/// Response type for Gamma API market queries
#[derive(Debug, Deserialize)]
struct GammaMarketResponse {
    id: String,
    #[serde(rename = "conditionId")]
    condition_id: String,
    #[serde(rename = "clobTokenIds")]
    clob_token_ids: Option<String>,
    outcomes: Option<String>,
    #[serde(rename = "endDate")]
    end_date: Option<String>,
    closed: Option<bool>,
}

