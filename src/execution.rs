use alloy::signers::local::PrivateKeySigner;
use alloy::signers::Signer;
use std::str::FromStr;
use std::sync::Arc;
use rtrb::Consumer;
use sqlx::PgPool;
use crate::polymarket::PolymarketClient;
use crate::database::{DbLogger, TradeLogMsg, insert_wallet_balance};
use crate::risk::RiskManager;

/// Toggle between live trading and dry run
pub const LIVE_MODE: bool = true;  // 🔴 LIVE TRADING ENABLED

pub struct TradeInstruction {
    pub symbol: u64,    // 15 = 15-min market, 60 = 60-min market
    pub side: u8,       // 0 = Buy YES (up), 1 = Buy NO (down)
    pub price_cents: u64,
    pub size: u64,
}

pub async fn run_execution(
    mut consumer: Consumer<TradeInstruction>, 
    db_logger: Arc<DbLogger>, 
    db_pool: PgPool, 
    risk_manager: Arc<RiskManager>,
    poly_client: Option<Arc<PolymarketClient>>,
    market_cache: crate::polymarket::MarketCache
) {
    println!("Starting Execution Engine...");
    println!("Mode: {}", if LIVE_MODE { "🔴 LIVE TRADING" } else { "🟢 DRY RUN" });
    println!("Risk Tier: {} | Trade Size: ${}", risk_manager.current_tier().name(), risk_manager.get_trade_size());
    
    // Log startup to activity log
    db_logger.log_activity("info", "system", 
        &format!("Execution Engine started: {} mode, {} tier", 
            if LIVE_MODE { "LIVE" } else { "DRY RUN" }, risk_manager.current_tier().name()),
        Some(format!(r#"{{"live_mode": {}, "tier": "{}", "trade_size": {}, "max_exposure": {:.2}}}"#,
            LIVE_MODE, risk_manager.current_tier().name(), risk_manager.get_trade_size(), risk_manager.get_max_exposure())));
    
    // Load Private Key from Environment
    let private_key = std::env::var("POLYMARKET_PRIVATE_KEY").expect("POLYMARKET_PRIVATE_KEY must be set");
    let signer = PrivateKeySigner::from_str(&private_key).expect("Invalid private key");
    let wallet_address = format!("{:?}", signer.address());

    println!("Signer Address: {}", wallet_address);

    // PnL Tracking - use starting balance from risk manager
    let starting_balance = 58.36;
    let mut total_balance: f64 = starting_balance;
    let mut total_profit: f64 = 0.0;
    let mut trade_count: u64 = 0;
    let mut last_logged_balance: f64 = starting_balance;

    loop {
        if let Ok(trade) = consumer.pop() {
            trade_count += 1;
            let price_f = trade.price_cents as f64 / 100.0;
            let size_f = trade.size as f64;
            
            // Calculate Projected Profit
            let shares = size_f / price_f;
            let payout = shares * 1.00;
            let profit = payout - size_f;
            
            // Decode asset and market type from symbol
            // Format: asset*100 + market_type (e.g., 160 = BTC 60-min, 215 = ETH 15-min)
            // SELL format: asset*100 + market_type + 1000 (e.g., 1160 = BTC 60-min SELL)
            let is_sell = trade.symbol >= 1000;
            let base_symbol = if is_sell { trade.symbol - 1000 } else { trade.symbol };
            let asset_id = base_symbol / 100;
            let market_mins = base_symbol % 100;
            
            let asset_name = match asset_id {
                1 => "BTC",
                2 => "ETH",
                3 => "SOL",
                4 => "XRP",
                _ => "UNKNOWN",
            };
            
            let market_type = match market_mins {
                15 => "15-MIN",
                60 => "60-MIN",
                _ => "UNKNOWN",
            };
            
            let action = if is_sell { "🔴 STOP-LOSS EXIT" } else { "🟢 ENTRY" };
            let side_str = if is_sell {
                if trade.side == 0 { "SELL NO → Close SHORT" } else { "SELL YES → Close LONG" }
            } else {
                if trade.side == 0 { "BUY YES (UP)" } else { "BUY NO (DOWN)" }
            };

            println!("\n══════════════════════════════════════════════════");
            println!(" {} TRADE #{} - {}", if LIVE_MODE { "🔴 LIVE" } else { "🟢 DRY RUN" }, trade_count, action);
            println!(" Market:   {} {}", asset_name, market_type);
            println!(" Side:     {}", side_str);
            println!(" Price:    ${:.2}", price_f);
            println!(" Size:     ${:.2}", size_f);
            
            // Execute trade (live or simulated)
            let mut order_success = false;
            let mut order_id: Option<String> = None;
            
            if LIVE_MODE {
                if let Some(ref client) = poly_client {
                    println!(" Status:   ⏳ LOOKING UP MARKET IN CACHE...");
                    
                    // Lookup market in cache
                    let mut found_market = None;
                    if let Ok(cache) = market_cache.read() {
                        if let Some(markets) = cache.get(asset_name) {
                            // Find matching market (15-min or 60-min)
                            found_market = markets.iter().find(|m| m.market_type == market_type).cloned();
                        }
                    }
                    
                    if let Some(market) = found_market {
                        println!(" Market:   {} ({})", market.question_id, market.condition_id);
                        
                        // Find the correct token ID
                        let target_outcome = if trade.side == 0 { "Up" } else { "Down" };
                        let token_index = market.outcomes.iter().position(|o| o.eq_ignore_ascii_case(target_outcome));
                        
                        if let Some(idx) = token_index {
                            let token_id = &market.token_ids[idx];
                            println!(" Token ID: {}...", &token_id[..20.min(token_id.len())]);
                            
                            // Create the order
                            let order = crate::polymarket::Order {
                                token_id: token_id.clone(),
                                price: price_f,
                                size: size_f,
                                side: if is_sell { 
                                    crate::polymarket::OrderSide::SELL 
                                } else { 
                                    crate::polymarket::OrderSide::BUY 
                                },
                                fee_rate_bps: 0,
                                nonce: trade_count,
                                expiration: 0, // No expiration
                                neg_risk: false, // Assuming false for now, or add to CachedMarket
                                tick_size: 0.001, // Default tick size
                            };
                            
                            println!(" Status:   ⏳ SIGNING ORDER...");
                            
                            // Sign and submit the order
                            match client.create_signed_order(&order).await {
                                Ok(signed_order) => {
                                    println!(" Status:   ⏳ SUBMITTING TO CLOB...");
                                    
                                    match client.place_order(signed_order).await {
                                        Ok(response) => {
                                            if response.success {
                                                order_success = true;
                                                order_id = response.order_id.clone();
                                                println!(" Status:   ✅ ORDER PLACED: {}", 
                                                    response.order_id.unwrap_or("unknown".to_string()));
                                                total_balance += profit;
                                                total_profit += profit;
                                            } else {
                                                println!(" Status:   ❌ ORDER REJECTED: {}", 
                                                    response.error_msg.unwrap_or("unknown error".to_string()));
                                            }
                                        }
                                        Err(e) => {
                                            println!(" Status:   ❌ ORDER FAILED: {}", e);
                                        }
                                    }
                                }
                                Err(e) => {
                                    println!(" Status:   ❌ SIGNING FAILED: {}", e);
                                }
                            }
                        } else {
                            println!(" Status:   ❌ TOKEN NOT FOUND for outcome: {}", target_outcome);
                        }
                    } else {
                        println!(" Status:   ❌ NO ACTIVE MARKET FOUND IN CACHE for {} {}", asset_name, market_type);
                        // Optional: Trigger immediate discovery if not found?
                    }
                } else {
                    println!(" Status:   ❌ NO API CLIENT - Skipped");
                }
            } else {
                // Dry run - just simulate
                let message = format!("Buy {} at {}", if trade.side == 0 { "YES" } else { "NO" }, trade.price_cents).into_bytes();
                let signature = signer.sign_message(&message).await.expect("Signing failed");
                
                order_success = true;
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
            let ticker = format!("{}-{}", asset_name, market_type);
            let side_db = if is_sell {
                if trade.side == 0 { "sell_no" } else { "sell_yes" }
            } else {
                if trade.side == 0 { "buy_yes" } else { "buy_no" }
            };
            
            db_logger.log_trade(TradeLogMsg {
                ticker: ticker.clone(),
                side: side_db.to_string(),
                price: price_f,
                size: size_f,
                value: price_f * size_f,
                latency_ms: None, // TODO: Calculate tick-to-trade latency
                pnl: Some(profit),
            });
            
            // Log trade execution with PnL to activity log
            let pnl_pct = (profit / size_f) * 100.0;
            
            // Update risk tier based on P&L
            let old_tier = risk_manager.current_tier();
            let new_tier = risk_manager.update_pnl(profit);
            
            // Log tier transition if changed
            if old_tier != new_tier {
                db_logger.log_activity("info", "system", 
                    &format!("Risk tier changed: {} → {}", old_tier.name(), new_tier.name()),
                    Some(format!(r#"{{"old_tier": "{}", "new_tier": "{}", "session_pnl": {:.2}, "new_trade_size": {}}}"#,
                        old_tier.name(), new_tier.name(), risk_manager.get_session_pnl(), new_tier.trade_size())));
            }
            
            db_logger.log_activity(
                if profit >= 0.0 { "success" } else { "warning" }, 
                "trade", 
                &format!("{}: {} | PnL: ${:.2} ({:.1}%) | Balance: ${:.2} | Tier: {}", 
                    ticker, side_db, profit, pnl_pct, total_balance, new_tier.name()),
                Some(format!(r#"{{"ticker": "{}", "side": "{}", "price": {:.2}, "size": {:.2}, "pnl": {:.2}, "pnl_pct": {:.2}, "total_balance": {:.2}, "total_profit": {:.2}, "trade_count": {}, "tier": "{}", "session_pnl": {:.2}}}"#,
                    ticker, side_db, price_f, size_f, profit, pnl_pct, total_balance, total_profit, trade_count, new_tier.name(), risk_manager.get_session_pnl())));
            
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

