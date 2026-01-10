//! Database module for persisting trading data to PostgreSQL.
//! 
//! This module provides async functions to write trade logs, strategy ticks,
//! heartbeats, and wallet balance snapshots to the dashboard database.

use sqlx::{postgres::PgPoolOptions, PgPool, Error};
use chrono::{DateTime, Utc};
use bigdecimal::BigDecimal;
use std::str::FromStr;

/// Initialize the database connection pool.
/// 
/// Reads `DATABASE_URL` from environment variables.
/// Returns a connection pool that can be shared across tasks.
pub async fn init_pool() -> Result<PgPool, Error> {
    let database_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set in environment variables");
    
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;
    
    println!("✅ Database connection pool initialized");
    Ok(pool)
}

/// Insert a trade log entry.
/// 
/// Called from execution.rs when a trade is executed.
pub async fn insert_trade_log(
    pool: &PgPool,
    ticker: &str,
    side: &str,
    price: f64,
    size: f64,
    value: f64,
    latency_ms: Option<i32>,
    pnl: Option<f64>,
) -> Result<(), Error> {
    let price_bd = BigDecimal::from_str(&format!("{:.8}", price)).unwrap_or_default();
    let size_bd = BigDecimal::from_str(&format!("{:.8}", size)).unwrap_or_default();
    let value_bd = BigDecimal::from_str(&format!("{:.8}", value)).unwrap_or_default();
    let pnl_bd = pnl.map(|p| BigDecimal::from_str(&format!("{:.8}", p)).unwrap_or_default());
    
    sqlx::query(
        r#"
        INSERT INTO trade_logs (ticker, side, price, size, value, latency_ms, pnl, executed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        "#
    )
    .bind(ticker)
    .bind(side)
    .bind(&price_bd)
    .bind(&size_bd)
    .bind(&value_bd)
    .bind(latency_ms)
    .bind(&pnl_bd)
    .execute(pool)
    .await?;
    
    Ok(())
}

/// Insert a strategy log entry.
/// 
/// Called from strategy.rs every 100th tick.
pub async fn insert_strategy_log(
    pool: &PgPool,
    tick_number: i32,
    price: f64,
    momentum_60: f64,
    momentum_15: f64,
    open_positions: i32,
) -> Result<(), Error> {
    let price_bd = BigDecimal::from_str(&format!("{:.8}", price)).unwrap_or_default();
    let mom_60_bd = BigDecimal::from_str(&format!("{:.6}", momentum_60)).unwrap_or_default();
    let mom_15_bd = BigDecimal::from_str(&format!("{:.6}", momentum_15)).unwrap_or_default();
    
    sqlx::query(
        r#"
        INSERT INTO strategy_logs (tick_number, price, momentum_60, momentum_15, open_positions)
        VALUES ($1, $2, $3, $4, $5)
        "#
    )
    .bind(tick_number)
    .bind(&price_bd)
    .bind(&mom_60_bd)
    .bind(&mom_15_bd)
    .bind(open_positions)
    .execute(pool)
    .await?;
    
    Ok(())
}

/// Upsert bot heartbeat status.
/// 
/// Called from main.rs every 10 seconds.
pub async fn upsert_heartbeat(
    pool: &PgPool,
    bot_id: &str,
    is_alive: bool,
    status: &str,
    avg_latency_ms: Option<i32>,
    orders_per_minute: Option<i32>,
    error_message: Option<&str>,
) -> Result<(), Error> {
    sqlx::query(
        r#"
        INSERT INTO bot_heartbeat (bot_id, is_alive, last_ping, status, avg_latency_ms, orders_per_minute, error_message)
        VALUES ($1, $2, NOW(), $3, $4, $5, $6)
        ON CONFLICT (bot_id) DO UPDATE SET
            is_alive = EXCLUDED.is_alive,
            last_ping = NOW(),
            status = EXCLUDED.status,
            avg_latency_ms = EXCLUDED.avg_latency_ms,
            orders_per_minute = EXCLUDED.orders_per_minute,
            error_message = EXCLUDED.error_message
        "#
    )
    .bind(bot_id)
    .bind(is_alive)
    .bind(status)
    .bind(avg_latency_ms)
    .bind(orders_per_minute)
    .bind(error_message)
    .execute(pool)
    .await?;
    
    Ok(())
}

/// Insert a wallet balance snapshot.
/// 
/// Called when balance changes after a trade.
pub async fn insert_wallet_balance(
    pool: &PgPool,
    balance: f64,
    currency: &str,
) -> Result<(), Error> {
    let balance_bd = BigDecimal::from_str(&format!("{:.8}", balance)).unwrap_or_default();
    
    sqlx::query(
        r#"
        INSERT INTO wallet_balance (balance, currency)
        VALUES ($1, $2)
        "#
    )
    .bind(&balance_bd)
    .bind(currency)
    .execute(pool)
    .await?;
    
    Ok(())
}

/// Database log sender that can be used from sync code.
/// 
/// This struct holds a channel sender that forwards log requests
/// to an async task that writes to the database.
#[derive(Clone)]
pub struct DbLogger {
    strategy_tx: tokio::sync::mpsc::UnboundedSender<StrategyLogMsg>,
    trade_tx: tokio::sync::mpsc::UnboundedSender<TradeLogMsg>,
}

pub struct StrategyLogMsg {
    pub tick_number: i32,
    pub price: f64,
    pub momentum_60: f64,
    pub momentum_15: f64,
    pub open_positions: i32,
}

pub struct TradeLogMsg {
    pub ticker: String,
    pub side: String,
    pub price: f64,
    pub size: f64,
    pub value: f64,
    pub latency_ms: Option<i32>,
    pub pnl: Option<f64>,
}

impl DbLogger {
    /// Create a new DbLogger and spawn background writer tasks.
    pub fn new(pool: PgPool) -> Self {
        let (strategy_tx, mut strategy_rx) = tokio::sync::mpsc::unbounded_channel::<StrategyLogMsg>();
        let (trade_tx, mut trade_rx) = tokio::sync::mpsc::unbounded_channel::<TradeLogMsg>();
        
        // Spawn strategy log writer
        let pool_clone = pool.clone();
        tokio::spawn(async move {
            while let Some(msg) = strategy_rx.recv().await {
                if let Err(e) = insert_strategy_log(
                    &pool_clone,
                    msg.tick_number,
                    msg.price,
                    msg.momentum_60,
                    msg.momentum_15,
                    msg.open_positions,
                ).await {
                    eprintln!("[DB] Strategy log error: {:?}", e);
                }
            }
        });
        
        // Spawn trade log writer
        let pool_clone = pool.clone();
        tokio::spawn(async move {
            while let Some(msg) = trade_rx.recv().await {
                if let Err(e) = insert_trade_log(
                    &pool_clone,
                    &msg.ticker,
                    &msg.side,
                    msg.price,
                    msg.size,
                    msg.value,
                    msg.latency_ms,
                    msg.pnl,
                ).await {
                    eprintln!("[DB] Trade log error: {:?}", e);
                }
            }
        });
        
        Self { strategy_tx, trade_tx }
    }
    
    /// Log a strategy tick (non-blocking, fire-and-forget).
    pub fn log_strategy(&self, msg: StrategyLogMsg) {
        let _ = self.strategy_tx.send(msg);
    }
    
    /// Log a trade execution (non-blocking, fire-and-forget).
    pub fn log_trade(&self, msg: TradeLogMsg) {
        let _ = self.trade_tx.send(msg);
    }
}
