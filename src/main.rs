mod ingestion;
mod strategy;
mod execution;
mod polymarket;
mod types;
mod database;
mod risk;

use rtrb::RingBuffer;
use std::thread;
use std::sync::Arc;
use database::{DbLogger, upsert_heartbeat};
use risk::RiskManager;
use polymarket::PolymarketClient;

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
    
    // Initialize Risk Manager with starting balance ($58.36)
    const STARTING_BALANCE: f64 = 58.36;
    let risk_manager = Arc::new(RiskManager::new(STARTING_BALANCE));

    // Initialize Market Cache (Shared between threads)
    let market_cache: polymarket::MarketCache = Arc::new(std::sync::RwLock::new(std::collections::HashMap::new()));

    // Initialize Polymarket Client (if in live mode)
    let poly_client = if execution::LIVE_MODE {
        match PolymarketClient::from_env() {
            Some(client) => {
                println!("✅ Polymarket API client initialized");
                let client_arc = Arc::new(client);
                
                // Fetch Initial Balance
                let client_clone_bal = client_arc.clone();
                let risk_clone_bal = risk_manager.clone();
                tokio::spawn(async move {
                    match client_clone_bal.fetch_balance().await {
                        Ok(balance) => {
                            println!("💰 Initial Balance: ${:.2}", balance);
                            // Update risk manager (we need a method for this, or just log it for now)
                            // risk_clone_bal.update_balance(balance); // TODO: Implement update_balance
                        }
                        Err(e) => eprintln!("❌ Failed to fetch initial balance: {}", e),
                    }
                });
                
                // Spawn Market Cache Updater
                let cache_clone = market_cache.clone();
                let client_clone = client_arc.clone();
                tokio::spawn(async move {
                    PolymarketClient::start_market_cache_updater(
                        client_clone, 
                        cache_clone, 
                        vec![] // Assets hardcoded in updater
                    ).await;
                });
                
                Some(client_arc)
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

    // PnL Tracking - use starting balance from risk manager
    let starting_balance = 58.36;
    let mut total_balance: f64 = starting_balance;
    let mut total_profit: f64 = 0.0;
    let mut trade_count: u64 = 0;
    let mut last_logged_balance: f64 = starting_balance;

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
    let exec_risk = Arc::clone(&risk_manager);
    let exec_cache = market_cache.clone();
    
    // We need to pass the client to execution if it exists
    // Note: execution::run_execution signature needs to change to accept client and cache
    tokio::spawn(async move {
        execution::run_execution(execution_cons, exec_logger, exec_pool, exec_risk, poly_client, exec_cache).await;
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
    let strategy_cache = market_cache.clone();
    thread::spawn(move || {
        strategy::run_strategy(strategy_cons, strategy_prod, strategy_logger, strategy_cache);
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
        // No cache in fallback mode for now, or create empty one
        let cache = Arc::new(std::sync::RwLock::new(std::collections::HashMap::new()));
        strategy::run_strategy_no_db(strategy_cons, strategy_prod, cache);
    });

    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
    }
}

