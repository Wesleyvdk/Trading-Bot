use crate::database::{insert_wallet_balance, DbLogger, TradeLogMsg};
use crate::polymarket::PolymarketClient;
use crate::risk::RiskManager;
use alloy_signer::Signer;
use alloy_signer::Signature;
use alloy_signer_local::PrivateKeySigner;
use rtrb::Consumer;
use sqlx::PgPool;
use std::str::FromStr;
use std::sync::Arc;

/// Toggle between live trading and dry run
pub const LIVE_MODE: bool = true; // 🔴 LIVE TRADING ENABLED

pub struct TradeInstruction {
    pub symbol: u64, // 15 = 15-min market, 60 = 60-min market
    pub side: u8,    // 0 = Buy YES (up), 1 = Buy NO (down)
    pub price_cents: u64,
    pub size: u64,
}

pub async fn run_execution(
    mut consumer: Consumer<TradeInstruction>,
    db_logger: Arc<DbLogger>,
    db_pool: PgPool,
    risk_manager: Arc<RiskManager>,
    poly_client: Option<Arc<PolymarketClient>>,
    market_cache: crate::polymarket::MarketCache,
) {
    println!("Starting Execution Engine...");
    println!(
        "Mode: {}",
        if LIVE_MODE {
            "🔴 LIVE TRADING"
        } else {
            "🟢 DRY RUN"
        }
    );
    println!(
        "Risk Tier: {} | Trade Size: ${}",
        risk_manager.current_tier().name(),
        risk_manager.get_trade_size()
    );

    // Log startup to activity log
    db_logger.log_activity(
        "info",
        "system",
        &format!(
            "Execution Engine started: {} mode, {} tier",
            if LIVE_MODE { "LIVE" } else { "DRY RUN" },
            risk_manager.current_tier().name()
        ),
        Some(format!(
            r#"{{"live_mode": {}, "tier": "{}", "trade_size": {}, "max_exposure": {:.2}}}"#,
            LIVE_MODE,
            risk_manager.current_tier().name(),
            risk_manager.get_trade_size(),
            risk_manager.get_max_exposure()
        )),
    );

    // Load Private Key from Environment
    let private_key =
        std::env::var("POLYMARKET_PRIVATE_KEY").expect("POLYMARKET_PRIVATE_KEY must be set");
    let signer = PrivateKeySigner::from_str(&private_key).expect("Invalid private key");
    let wallet_address = format!("{:?}", signer.address());

    println!("Signer Address: {}", wallet_address);

    // PnL Tracking - use starting balance from risk manager
    let starting_balance = 58.36;
    let mut total_balance: f64 = starting_balance;
    let mut _total_profit: f64 = 0.0;
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
            let base_symbol = if is_sell {
                trade.symbol - 1000
            } else {
                trade.symbol
            };
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

            let action = if is_sell {
                "🔴 STOP-LOSS EXIT"
            } else {
                "🟢 ENTRY"
            };
            let side_str = if is_sell {
                if trade.side == 0 {
                    "SELL NO → Close SHORT"
                } else {
                    "SELL YES → Close LONG"
                }
            } else {
                if trade.side == 0 {
                    "BUY YES (UP)"
                } else {
                    "BUY NO (DOWN)"
                }
            };

            println!("\n══════════════════════════════════════════════════");
            println!(
                " {} TRADE #{} - {}",
                if LIVE_MODE {
                    "🔴 LIVE"
                } else {
                    "🟢 DRY RUN"
                },
                trade_count,
                action
            );
            println!(" Market:   {} {}", asset_name, market_type);
            println!(" Side:     {}", side_str);
            println!(" Price:    ${:.2}", price_f);
            println!(" Size:     ${:.2}", size_f);

            // Execute trade (live or simulated)
            let mut _order_success = false;
            let mut _order_id: Option<String> = None;

            if LIVE_MODE {
                if let Some(ref client) = poly_client {
                    println!(" Status:   ⏳ LOOKING UP MARKET IN CACHE...");

                    // Lookup market in cache
                    let mut found_market = None;
                    if let Ok(cache) = market_cache.read() {
                        if let Some(markets) = cache.get(asset_name) {
                            // Try to find exact market type first (15-MIN or 60-MIN)
                            found_market = markets
                                .iter()
                                .find(|m| m.market_type == market_type)
                                .cloned();
                            
                            // Fallback: If no 60-MIN or 15-MIN market found, use DAILY
                            // (Polymarket may not have hourly crypto markets available)
                            if found_market.is_none() {
                                found_market = markets
                                    .iter()
                                    .find(|m| m.market_type == "DAILY")
                                    .cloned();
                                if found_market.is_some() {
                                    println!(" Fallback: Using DAILY market (no {} available)", market_type);
                                }
                            }
                        }
                    }

                    if let Some(market) = found_market {
                        println!(
                            " Market:   {} ({})",
                            market.question_id, market.condition_id
                        );

                        // Find the correct token ID
                        // For crypto markets: side 0 = Up (price going up), side 1 = Down
                        // Some markets use "Yes"/"No" instead of "Up"/"Down"
                        let target_outcome = if trade.side == 0 { "Up" } else { "Down" };
                        let alt_outcome = if trade.side == 0 { "Yes" } else { "No" };
                        
                        // Debug: show available outcomes
                        println!(" Outcomes: {:?}", market.outcomes);
                        
                        // Try primary outcome first, then fallback
                        let token_index = market
                            .outcomes
                            .iter()
                            .position(|o| o.eq_ignore_ascii_case(target_outcome))
                            .or_else(|| market.outcomes.iter().position(|o| o.eq_ignore_ascii_case(alt_outcome)))
                            .or_else(|| {
                                // Last resort: use index directly (0 for Up/Yes, 1 for Down/No)
                                if trade.side == 0 && market.outcomes.len() >= 1 { Some(0) }
                                else if trade.side == 1 && market.outcomes.len() >= 2 { Some(1) }
                                else { None }
                            });

                        if let Some(idx) = token_index {
                            let token_id = &market.token_ids[idx];
                            println!(" Token ID: {}...", &token_id[..20.min(token_id.len())]);

                            // ============================================
                            // VALUE FILTERING: Check price before trading
                            // ============================================
                            println!(" Status:   ⏳ FETCHING ORDERBOOK PRICE...");
                            
                            let orderbook = crate::prices::fetch_orderbook(token_id).await;
                            
                            if let Some((bid, ask)) = orderbook {
                                let entry_price = ask; // We pay the ask
                                println!(" Orderbook: bid=${:.3}, ask=${:.3}", bid, ask);
                                
                                // Apply value filters
                                match crate::prices::passes_value_filters(entry_price, bid, ask) {
                                    Ok((upside, spread)) => {
                                        println!(" Filters:  ✅ PASSED (upside={:.1}%, spread={:.1}%)", 
                                            upside * 100.0, spread * 100.0);
                                        
                                        println!(" Status:   ⏳ PLACING ORDER @ ${:.3}...", entry_price);
                                        
                                        // Place the order with actual orderbook price
                                        match client
                                            .place_order(
                                                token_id,
                                                if is_sell {
                                                    crate::polymarket::OrderSide::SELL
                                                } else {
                                                    crate::polymarket::OrderSide::BUY
                                                },
                                                size_f,
                                                entry_price, // Use actual orderbook price
                                            )
                                            .await
                                        {
                                            Ok(id) => {
                                                _order_success = true;
                                                _order_id = Some(id.clone());
                                                // Recalculate profit with actual price
                                                let actual_shares = size_f / entry_price;
                                                let actual_profit = actual_shares * 1.0 - size_f;
                                                println!(" Status:   ✅ ORDER PLACED: {}", id);
                                                println!(" Actual:   {} shares @ ${:.3}, profit=${:.2} if win", 
                                                    actual_shares, entry_price, actual_profit);
                                                total_balance += actual_profit;
                                                _total_profit += actual_profit;
                                            }
                                            Err(e) => {
                                                println!(" Status:   ❌ ORDER FAILED: {}", e);
                                            }
                                        }
                                    }
                                    Err(reason) => {
                                        println!(" Filters:  ⏭️ SKIPPED - {}", reason);
                                        println!("           price=${:.3}, max=${:.2}", 
                                            entry_price, crate::prices::MAX_ENTRY_PRICE);
                                        
                                        // Log skipped trade to activity log
                                        db_logger.log_activity(
                                            "info",
                                            "filter",
                                            &format!("{} {} skipped: {}", asset_name, market_type, reason),
                                            Some(format!(r#"{{"asset": "{}", "market": "{}", "reason": "{}", "price": {:.3}, "bid": {:.3}, "ask": {:.3}}}"#,
                                                asset_name, market_type, reason, entry_price, bid, ask)),
                                        );
                                    }
                                }
                            } else {
                                println!(" Status:   ❌ COULD NOT FETCH ORDERBOOK");
                            }
                        } else {
                            println!(
                                " Status:   ❌ TOKEN NOT FOUND for outcome: {}",
                                target_outcome
                            );
                        }
                    } else {
                        println!(
                            " Status:   ❌ NO ACTIVE MARKET FOUND IN CACHE for {} {}",
                            asset_name, market_type
                        );
                        // Optional: Trigger immediate discovery if not found?
                    }
                } else {
                    println!(" Status:   ❌ NO API CLIENT - Skipped");
                }
            } else {
                // Dry run - just simulate
                let message = format!(
                    "Buy {} at {}",
                    if trade.side == 0 { "YES" } else { "NO" },
                    trade.price_cents
                )
                .into_bytes();
                let signature: Signature = signer.sign_message(&message).await.expect("Signing failed");

                _order_success = true;
                total_balance += profit;
                _total_profit += profit;

                println!(" ──────────────────────────────────────────────────");
                println!(" Projected Profit: ${:.2} (if win)", profit);
                println!(" Total Balance:    ${:.2}", total_balance);
                println!(" Total Profit:     ${:.2}", _total_profit);
                println!(" Signature: 0x{}...", &format!("{:?}", signature)[..40]);
            }

            println!("══════════════════════════════════════════════════\n");

            // Log trade to database
            let ticker = format!("{}-{}", asset_name, market_type);
            let side_db = if is_sell {
                if trade.side == 0 {
                    "sell_no"
                } else {
                    "sell_yes"
                }
            } else {
                if trade.side == 0 {
                    "buy_yes"
                } else {
                    "buy_no"
                }
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
                    ticker, side_db, price_f, size_f, profit, pnl_pct, total_balance, _total_profit, trade_count, new_tier.name(), risk_manager.get_session_pnl())));

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

    let private_key =
        std::env::var("POLYMARKET_PRIVATE_KEY").expect("POLYMARKET_PRIVATE_KEY must be set");
    let signer = PrivateKeySigner::from_str(&private_key).expect("Invalid private key");

    let mut total_balance: f64 = 50.0;
    let mut _total_profit: f64 = 0.0;
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

            let message = format!(
                "Buy {} at {}",
                if trade.side == 0 { "YES" } else { "NO" },
                trade.price_cents
            )
            .into_bytes();
            let _signature = signer.sign_message(&message).await.expect("Signing failed");

            total_balance += profit;
            _total_profit += profit;

            println!(
                "[EXEC] Trade #{}: {} BTC, balance=${:.2}",
                trade_count, market_type, total_balance
            );
        }

        tokio::task::yield_now().await;
    }
}
