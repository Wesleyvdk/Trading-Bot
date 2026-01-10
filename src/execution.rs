use alloy::signers::local::PrivateKeySigner;
use alloy::signers::Signer;
use std::str::FromStr;
use std::sync::Arc;
use rtrb::Consumer;
use sqlx::PgPool;
use crate::polymarket::PolymarketClient;
use crate::database::{DbLogger, TradeLogMsg, insert_wallet_balance};

/// Toggle between live trading and dry run
const LIVE_MODE: bool = false;  // Set to true to enable real trading

/// Trade size in dollars
const TRADE_SIZE_DOLLARS: u64 = 1;  // Start with $1 for safety

pub struct TradeInstruction {
    pub symbol: u64,    // 15 = 15-min market, 60 = 60-min market
    pub side: u8,       // 0 = Buy YES (up), 1 = Buy NO (down)
    pub price_cents: u64,
    pub size: u64,
}

pub async fn run_execution(mut consumer: Consumer<TradeInstruction>, db_logger: Arc<DbLogger>, db_pool: PgPool) {
    println!("Starting Execution Engine...");
    println!("Mode: {}", if LIVE_MODE { "🔴 LIVE TRADING" } else { "🟢 DRY RUN" });
    
    // Load Private Key from Environment
    let private_key = std::env::var("POLYMARKET_PRIVATE_KEY").expect("POLYMARKET_PRIVATE_KEY must be set");
    let signer = PrivateKeySigner::from_str(&private_key).expect("Invalid private key");
    let wallet_address = format!("{:?}", signer.address());

    println!("Signer Address: {}", wallet_address);

    // Initialize Polymarket Client (if in live mode)
    let poly_client = if LIVE_MODE {
        match PolymarketClient::from_env() {
            Some(client) => {
                println!("✅ Polymarket API client initialized");
                Some(client)
            }
            None => {
                eprintln!("❌ POLYMARKET_API_KEY, POLYMARKET_API_SECRET, or POLYMARKET_PASSPHRASE not set!");
                eprintln!("   Falling back to DRY RUN mode");
                None
            }
        }
    } else {
        None
    };

    // PnL Tracking
    let mut total_balance: f64 = 50.0;
    let mut total_profit: f64 = 0.0;
    let mut trade_count: u64 = 0;
    let mut last_logged_balance: f64 = 50.0;

    loop {
        if let Ok(trade) = consumer.pop() {
            trade_count += 1;
            let price_f = trade.price_cents as f64 / 100.0;
            let size_f = trade.size as f64;
            
            // Calculate Projected Profit
            let shares = size_f / price_f;
            let payout = shares * 1.00;
            let profit = payout - size_f;
            
            // Determine market type and action
            let (market_type, is_sell) = match trade.symbol {
                15 => ("15-MIN", false),
                60 => ("60-MIN", false),
                1015 => ("15-MIN", true),  // SELL/EXIT
                1060 => ("60-MIN", true),  // SELL/EXIT
                _ => ("UNKNOWN", false),
            };
            
            let action = if is_sell { "🔴 STOP-LOSS EXIT" } else { "🟢 ENTRY" };
            let side_str = if is_sell {
                if trade.side == 0 { "SELL NO → Close SHORT" } else { "SELL YES → Close LONG" }
            } else {
                if trade.side == 0 { "BUY YES (UP)" } else { "BUY NO (DOWN)" }
            };

            println!("\n══════════════════════════════════════════════════");
            println!(" {} TRADE #{} - {}", if LIVE_MODE { "🔴 LIVE" } else { "🟢 DRY RUN" }, trade_count, action);
            println!(" Market:   {} BTC", market_type);
            println!(" Side:     {}", side_str);
            println!(" Price:    ${:.2}", price_f);
            println!(" Size:     ${:.2}", size_f);
            
            // Execute trade (live or simulated)
            if LIVE_MODE {
                if let Some(ref _client) = poly_client {
                    println!(" Status:   ⏳ SUBMITTING ORDER...");
                    println!(" Status:   ✅ ORDER SUBMITTED (simulated)");
                    total_balance += profit;
                    total_profit += profit;
                } else {
                    println!(" Status:   ❌ NO API CLIENT - Skipped");
                }
            } else {
                // Dry run - just simulate
                let message = format!("Buy {} at {}", if trade.side == 0 { "YES" } else { "NO" }, trade.price_cents).into_bytes();
                let signature = signer.sign_message(&message).await.expect("Signing failed");
                
                total_balance += profit;
                total_profit += profit;
                
                println!(" ──────────────────────────────────────────────────");
                println!(" Projected Profit: ${:.2} (if win)", profit);
                println!(" Total Balance:    ${:.2}", total_balance);
                println!(" Total Profit:     ${:.2}", total_profit);
                println!(" Signature: 0x{}...", &format!("{:?}", signature)[..40]);
            }
            
            println!("══════════════════════════════════════════════════\n");
            
            // Log trade to database
            let ticker = format!("BTC-{}", market_type);
            let side_db = if is_sell {
                if trade.side == 0 { "sell_no" } else { "sell_yes" }
            } else {
                if trade.side == 0 { "buy_yes" } else { "buy_no" }
            };
            
            db_logger.log_trade(TradeLogMsg {
                ticker,
                side: side_db.to_string(),
                price: price_f,
                size: size_f,
                value: price_f * size_f,
                latency_ms: None, // TODO: Calculate tick-to-trade latency
                pnl: Some(profit),
            });
            
            // Log wallet balance if changed significantly
            if (total_balance - last_logged_balance).abs() > 0.01 {
                if let Err(e) = insert_wallet_balance(&db_pool, total_balance, "USDC").await {
                    eprintln!("[WALLET] DB error: {:?}", e);
                }
                last_logged_balance = total_balance;
            }
        }
        
        tokio::task::yield_now().await;
    }
}

/// Fallback: Run execution without database logging
pub async fn run_execution_no_db(mut consumer: Consumer<TradeInstruction>) {
    println!("Starting Execution Engine (NO DB MODE)...");
    
    let private_key = std::env::var("POLYMARKET_PRIVATE_KEY").expect("POLYMARKET_PRIVATE_KEY must be set");
    let signer = PrivateKeySigner::from_str(&private_key).expect("Invalid private key");
    
    let mut total_balance: f64 = 50.0;
    let mut total_profit: f64 = 0.0;
    let mut trade_count: u64 = 0;

    loop {
        if let Ok(trade) = consumer.pop() {
            trade_count += 1;
            let price_f = trade.price_cents as f64 / 100.0;
            let size_f = trade.size as f64;
            let shares = size_f / price_f;
            let payout = shares * 1.00;
            let profit = payout - size_f;
            
            let (market_type, _is_sell) = match trade.symbol {
                15 => ("15-MIN", false),
                60 => ("60-MIN", false),
                1015 => ("15-MIN", true),
                1060 => ("60-MIN", true),
                _ => ("UNKNOWN", false),
            };
            
            let message = format!("Buy {} at {}", if trade.side == 0 { "YES" } else { "NO" }, trade.price_cents).into_bytes();
            let _ = signer.sign_message(&message).await;
            
            total_balance += profit;
            total_profit += profit;
            
            println!("[EXEC] Trade #{}: {} BTC, balance=${:.2}", trade_count, market_type, total_balance);
        }
        
        tokio::task::yield_now().await;
    }
}

