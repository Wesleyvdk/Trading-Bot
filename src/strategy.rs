use rtrb::{Consumer, Producer};
use crate::ingestion::MarketUpdate;
use crate::execution::TradeInstruction;
use crate::types::PriceSnapshot;
use crate::database::{DbLogger, StrategyLogMsg};
use std::time::{Instant, Duration};
use std::collections::VecDeque;
use std::sync::Arc;

/// Configuration for the strategy
const MOMENTUM_WINDOW_60MIN_SECS: u64 = 600;  // 10 minutes for 60-min markets
const MOMENTUM_WINDOW_15MIN_SECS: u64 = 180;  // 3 minutes for 15-min markets
// TESTING: Lowered thresholds to trigger trades in stable markets
// PRODUCTION: 0.003 (0.3%) and 0.005 (0.5%)
const MOMENTUM_THRESHOLD_60MIN: f64 = 0.0005;  // 0.05% move (TESTING)
const MOMENTUM_THRESHOLD_15MIN: f64 = 0.001;   // 0.10% move (TESTING)
const TRADE_SIZE_DOLLARS: u64 = 10;
const MAX_POSITIONS: usize = 3;
const COOLDOWN_SECS: u64 = 5;

/// Stop-loss configuration
/// Only check stop-loss in the LAST X minutes before market expiry
const STOP_LOSS_THRESHOLD_15MIN: f64 = 0.002;   // 0.2% reversal for 15-min
const STOP_LOSS_THRESHOLD_60MIN: f64 = 0.003;   // 0.3% reversal for 60-min
const STOP_LOSS_ACTIVE_15MIN_SECS: u64 = 180;   // Last 3 min of 15-min market (12 min safe)
const STOP_LOSS_ACTIVE_60MIN_SECS: u64 = 900;   // Last 15 min of 60-min market (45 min safe)
const MARKET_DURATION_15MIN_SECS: u64 = 900;    // 15 min = 900 sec
const MARKET_DURATION_60MIN_SECS: u64 = 3600;   // 60 min = 3600 sec

/// Represents an open position
#[derive(Debug, Clone)]
struct Position {
    market_type: u64,       // 15 or 60
    side: u8,               // 0 = YES (up), 1 = NO (down)
    entry_momentum: f64,    // Momentum at entry
    entry_time: Instant,
    entry_price_cents: u64,
}

pub fn run_strategy(mut consumer: Consumer<MarketUpdate>, mut producer: Producer<TradeInstruction>, db_logger: Arc<DbLogger>) {
    println!("Starting Strategy Engine (0x8dxd Mode + Stop-Loss)...");
    
    // Price history for momentum calculation (rolling window)
    let mut price_history: VecDeque<PriceSnapshot> = VecDeque::with_capacity(1000);
    
    // Position tracking
    let mut open_positions: Vec<Position> = Vec::with_capacity(MAX_POSITIONS);
    
    // Rate limiting
    let cooldown = Duration::from_secs(COOLDOWN_SECS);
    let mut last_trade_time: Option<Instant> = None;
    let mut tick_count: u64 = 0;
    
    // Performance monitoring
    let mut perf_tick_count: u64 = 0;
    let mut perf_last_report = Instant::now();
    const PERF_REPORT_INTERVAL_SECS: u64 = 10;
    
    // Core Affinity (Pin to Core 2)
    if let Some(core_ids) = core_affinity::get_core_ids() {
        if core_ids.len() > 2 {
            core_affinity::set_for_current(core_ids[2]);
            println!("Strategy Pinned to Core 2");
        }
    }

    loop {
        if let Ok(update) = consumer.pop() {
            tick_count += 1;
            perf_tick_count += 1;
            
            // Performance report every 10 seconds
            if perf_last_report.elapsed() >= Duration::from_secs(PERF_REPORT_INTERVAL_SECS) {
                let elapsed = perf_last_report.elapsed().as_secs_f64();
                let tps = perf_tick_count as f64 / elapsed;
                println!("[PERF] Last {:.0}s: {} ticks ({:.1}/sec), Positions: {}",
                    elapsed, perf_tick_count, tps, open_positions.len());
                perf_tick_count = 0;
                perf_last_report = Instant::now();
            }
            
            // Only process Binance updates (Symbol 1) for momentum
            if update.symbol != 1 {
                continue;
            }
            
            // Add to price history
            let snapshot = PriceSnapshot::new(update.price, update.ts);
            price_history.push_back(snapshot);
            
            // Prune old prices (keep last 15 minutes)
            let now_ms = update.ts;
            let cutoff_ms = now_ms.saturating_sub(900_000); // 15 min in ms
            while let Some(front) = price_history.front() {
                if front.timestamp_ms < cutoff_ms {
                    price_history.pop_front();
                } else {
                    break;
                }
            }
            
            // Calculate momentum for different windows
            let momentum_60 = calculate_momentum(&price_history, now_ms, MOMENTUM_WINDOW_60MIN_SECS * 1000);
            let momentum_15 = calculate_momentum(&price_history, now_ms, MOMENTUM_WINDOW_15MIN_SECS * 1000);
            
            // Debug: Log every 100th tick
            if tick_count % 100 == 0 {
                let price_dollars = update.price as f64 / 100.0;
                println!("[STRATEGY] Tick #{}: price=${:.2}, mom_60={:.4}%, mom_15={:.4}%, positions={}", 
                    tick_count, price_dollars, momentum_60 * 100.0, momentum_15 * 100.0, open_positions.len());
                
                // Log to database
                db_logger.log_strategy(StrategyLogMsg {
                    tick_number: tick_count as i32,
                    price: price_dollars,
                    momentum_60: momentum_60 * 100.0,
                    momentum_15: momentum_15 * 100.0,
                    open_positions: open_positions.len() as i32,
                });
            }
            
            // ============================================
            // STOP-LOSS CHECK: Exit positions if momentum reverses
            // ============================================
            let mut positions_to_close: Vec<usize> = Vec::new();
            
            for (idx, pos) in open_positions.iter().enumerate() {
                let current_momentum = if pos.market_type == 60 { momentum_60 } else { momentum_15 };
                
                // Get market duration and danger zone based on market type
                let (market_duration, danger_zone, threshold) = if pos.market_type == 60 {
                    (Duration::from_secs(MARKET_DURATION_60MIN_SECS), 
                     Duration::from_secs(STOP_LOSS_ACTIVE_60MIN_SECS), 
                     STOP_LOSS_THRESHOLD_60MIN)
                } else {
                    (Duration::from_secs(MARKET_DURATION_15MIN_SECS), 
                     Duration::from_secs(STOP_LOSS_ACTIVE_15MIN_SECS), 
                     STOP_LOSS_THRESHOLD_15MIN)
                };
                
                // Only check stop-loss in the LAST X minutes (danger zone)
                let time_until_expiry = market_duration.saturating_sub(pos.entry_time.elapsed());
                if time_until_expiry > danger_zone {
                    continue; // Still in safe zone, no stop-loss check
                }
                
                // Check if momentum has reversed significantly
                let reversal = if pos.side == 0 {
                    // We bought YES (bet on UP) - check if momentum went negative
                    pos.entry_momentum - current_momentum
                } else {
                    // We bought NO (bet on DOWN) - check if momentum went positive
                    current_momentum - pos.entry_momentum
                };
                
                if reversal >= threshold {
                    println!("[STOP-LOSS] Position {} triggered! Reversal: {:.4}% ({}s until expiry)",
                        idx, reversal * 100.0, time_until_expiry.as_secs());
                    positions_to_close.push(idx);
                    
                    // Send SELL instruction
                    let sell_instruction = TradeInstruction {
                        symbol: pos.market_type + 1000, // 1015 = SELL 15-min, 1060 = SELL 60-min
                        side: if pos.side == 0 { 1 } else { 0 }, // Opposite of entry
                        price_cents: 40, // Sell at whatever price (stop-loss)
                        size: TRADE_SIZE_DOLLARS,
                    };
                    
                    if producer.push(sell_instruction).is_ok() {
                        println!("[STRATEGY] STOP-LOSS EXIT: {}-MIN {} (reversal={:.4}%)",
                            pos.market_type,
                            if pos.side == 0 { "SELL YES" } else { "SELL NO" },
                            reversal * 100.0);
                    }
                }
            }
            
            // Remove closed positions (reverse order to preserve indices)
            for idx in positions_to_close.into_iter().rev() {
                open_positions.remove(idx);
            }
            
            // ============================================
            // ENTRY LOGIC
            // ============================================
            
            // Check rate limiting
            if let Some(last_time) = last_trade_time {
                if last_time.elapsed() < cooldown {
                    continue;
                }
            }
            
            // Check position limit
            if open_positions.len() >= MAX_POSITIONS {
                continue;
            }
            
            // Entry Logic: 60-minute markets
            if momentum_60.abs() >= MOMENTUM_THRESHOLD_60MIN {
                let side = if momentum_60 > 0.0 { 0 } else { 1 };
                let instruction = TradeInstruction {
                    symbol: 60,
                    side,
                    price_cents: 50,
                    size: TRADE_SIZE_DOLLARS,
                };
                
                if let Ok(()) = producer.push(instruction) {
                    println!("[STRATEGY] 60-MIN ENTRY: {} (momentum={:.4}%)", 
                        if side == 0 { "BUY YES (UP)" } else { "BUY NO (DOWN)" },
                        momentum_60 * 100.0);
                    
                    // Track position
                    open_positions.push(Position {
                        market_type: 60,
                        side,
                        entry_momentum: momentum_60,
                        entry_time: Instant::now(),
                        entry_price_cents: 50,
                    });
                    
                    last_trade_time = Some(Instant::now());
                }
            }
            
            // Entry Logic: 15-minute markets
            if momentum_15.abs() >= MOMENTUM_THRESHOLD_15MIN && open_positions.len() < MAX_POSITIONS {
                let side = if momentum_15 > 0.0 { 0 } else { 1 };
                let instruction = TradeInstruction {
                    symbol: 15,
                    side,
                    price_cents: 50,
                    size: TRADE_SIZE_DOLLARS,
                };
                
                if let Ok(()) = producer.push(instruction) {
                    println!("[STRATEGY] 15-MIN ENTRY: {} (momentum={:.4}%)", 
                        if side == 0 { "BUY YES (UP)" } else { "BUY NO (DOWN)" },
                        momentum_15 * 100.0);
                    
                    // Track position
                    open_positions.push(Position {
                        market_type: 15,
                        side,
                        entry_momentum: momentum_15,
                        entry_time: Instant::now(),
                        entry_price_cents: 50,
                    });
                    
                    last_trade_time = Some(Instant::now());
                }
            }
        }
    }
}

/// Calculate price momentum over a given window
fn calculate_momentum(history: &VecDeque<PriceSnapshot>, now_ms: u64, window_ms: u64) -> f64 {
    if history.is_empty() {
        return 0.0;
    }
    
    let cutoff = now_ms.saturating_sub(window_ms);
    
    let oldest = history.iter()
        .find(|p| p.timestamp_ms >= cutoff)
        .map(|p| p.price_cents);
    
    let current = history.back().map(|p| p.price_cents);
    
    match (oldest, current) {
        (Some(old), Some(cur)) if old > 0 => {
            (cur as f64 - old as f64) / old as f64
        }
        _ => 0.0,
    }
}

/// Fallback: Run strategy without database logging
pub fn run_strategy_no_db(mut consumer: Consumer<MarketUpdate>, mut producer: Producer<TradeInstruction>) {
    println!("Starting Strategy Engine (NO DB MODE)...");
    
    let mut price_history: VecDeque<PriceSnapshot> = VecDeque::with_capacity(1000);
    let mut open_positions: Vec<Position> = Vec::with_capacity(MAX_POSITIONS);
    let cooldown = Duration::from_secs(COOLDOWN_SECS);
    let mut last_trade_time: Option<Instant> = None;
    let mut tick_count: u64 = 0;

    loop {
        if let Ok(update) = consumer.pop() {
            tick_count += 1;
            
            if update.symbol != 1 { continue; }
            
            let snapshot = PriceSnapshot::new(update.price, update.ts);
            price_history.push_back(snapshot);
            
            let now_ms = update.ts;
            let cutoff_ms = now_ms.saturating_sub(900_000);
            while let Some(front) = price_history.front() {
                if front.timestamp_ms < cutoff_ms {
                    price_history.pop_front();
                } else { break; }
            }
            
            let momentum_60 = calculate_momentum(&price_history, now_ms, MOMENTUM_WINDOW_60MIN_SECS * 1000);
            let momentum_15 = calculate_momentum(&price_history, now_ms, MOMENTUM_WINDOW_15MIN_SECS * 1000);
            
            if tick_count % 100 == 0 {
                let price_dollars = update.price as f64 / 100.0;
                println!("[STRATEGY] Tick #{}: price=${:.2}, mom_60={:.4}%, mom_15={:.4}%, positions={}", 
                    tick_count, price_dollars, momentum_60 * 100.0, momentum_15 * 100.0, open_positions.len());
            }
            
            // Check rate limiting and position limit
            if let Some(last_time) = last_trade_time {
                if last_time.elapsed() < cooldown { continue; }
            }
            if open_positions.len() >= MAX_POSITIONS { continue; }
            
            // Entry Logic: 60-minute markets
            if momentum_60.abs() >= MOMENTUM_THRESHOLD_60MIN {
                let side = if momentum_60 > 0.0 { 0 } else { 1 };
                let instruction = TradeInstruction { symbol: 60, side, price_cents: 50, size: TRADE_SIZE_DOLLARS };
                if producer.push(instruction).is_ok() {
                    open_positions.push(Position { market_type: 60, side, entry_momentum: momentum_60, entry_time: Instant::now(), entry_price_cents: 50 });
                    last_trade_time = Some(Instant::now());
                }
            }
            
            // Entry Logic: 15-minute markets
            if momentum_15.abs() >= MOMENTUM_THRESHOLD_15MIN && open_positions.len() < MAX_POSITIONS {
                let side = if momentum_15 > 0.0 { 0 } else { 1 };
                let instruction = TradeInstruction { symbol: 15, side, price_cents: 50, size: TRADE_SIZE_DOLLARS };
                if producer.push(instruction).is_ok() {
                    open_positions.push(Position { market_type: 15, side, entry_momentum: momentum_15, entry_time: Instant::now(), entry_price_cents: 50 });
                    last_trade_time = Some(Instant::now());
                }
            }
        }
    }
}
