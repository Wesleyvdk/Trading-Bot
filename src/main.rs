mod ingestion;
mod strategy;
mod execution;
mod polymarket;
mod types;
mod database;

use rtrb::RingBuffer;
use std::thread;
use std::sync::Arc;
use database::{DbLogger, upsert_heartbeat};

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();
    println!("Starting Low-Latency Polymarket Arbitrage Engine...");

    // Initialize Database Connection Pool
    let db_pool = match database::init_pool().await {
        Ok(pool) => pool,
        Err(e) => {
            eprintln!("❌ Failed to connect to database: {:?}", e);
            eprintln!("   Continuing without database logging...");
            // Continue without DB - don't crash the bot
            run_without_db().await;
            return;
        }
    };
    
    // Create DbLogger for non-blocking writes from sync code
    let db_logger = Arc::new(DbLogger::new(db_pool.clone()));

    // 1. Ingestion -> Strategy Ring Buffer (Capacity 1024)
    let (ingestion_prod, strategy_cons) = RingBuffer::<ingestion::MarketUpdate>::new(1024);

    // 2. Strategy -> Execution Ring Buffer (Capacity 1024)
    let (strategy_prod, execution_cons) = RingBuffer::<execution::TradeInstruction>::new(1024);

    // Spawn Ingestion Thread
    tokio::spawn(async move {
        ingestion::run_ingestion(ingestion_prod).await;
    });

    // Spawn Execution Thread
    let exec_logger = Arc::clone(&db_logger);
    let exec_pool = db_pool.clone();
    tokio::spawn(async move {
        execution::run_execution(execution_cons, exec_logger, exec_pool).await;
    });

    // Spawn Heartbeat Task (every 10 seconds)
    let heartbeat_pool = db_pool.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(10));
        loop {
            interval.tick().await;
            if let Err(e) = upsert_heartbeat(
                &heartbeat_pool,
                "main",
                true,
                "trading",
                None, // TODO: Calculate avg latency
                None, // TODO: Track orders per minute
                None,
            ).await {
                eprintln!("[HEARTBEAT] DB error: {:?}", e);
            }
        }
    });

    // Run Strategy (Blocking/Pinned)
    let strategy_logger = Arc::clone(&db_logger);
    thread::spawn(move || {
        strategy::run_strategy(strategy_cons, strategy_prod, strategy_logger);
    });

    // Keep main alive
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
    }
}

/// Fallback: Run without database logging
async fn run_without_db() {
    let (ingestion_prod, strategy_cons) = RingBuffer::<ingestion::MarketUpdate>::new(1024);
    let (strategy_prod, execution_cons) = RingBuffer::<execution::TradeInstruction>::new(1024);

    tokio::spawn(async move {
        ingestion::run_ingestion(ingestion_prod).await;
    });

    tokio::spawn(async move {
        execution::run_execution_no_db(execution_cons).await;
    });

    thread::spawn(move || {
        strategy::run_strategy_no_db(strategy_cons, strategy_prod);
    });

    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
    }
}

