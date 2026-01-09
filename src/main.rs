mod ingestion;
mod strategy;
mod execution;
mod polymarket;

use rtrb::RingBuffer;
use std::thread;

#[tokio::main]
async fn main() {
    println!("Starting Low-Latency Polymarket Arbitrage Engine...");

    // 1. Ingestion -> Strategy Ring Buffer (Capacity 1024)
    let (ingestion_prod, strategy_cons) = RingBuffer::<ingestion::MarketUpdate>::new(1024);

    // 2. Strategy -> Execution Ring Buffer (Capacity 1024)
    let (strategy_prod, execution_cons) = RingBuffer::<execution::TradeInstruction>::new(1024);

    // Spawn Ingestion Thread
    tokio::spawn(async move {
        ingestion::run_ingestion(ingestion_prod).await;
    });

    // Spawn Execution Thread
    tokio::spawn(async move {
        execution::run_execution(execution_cons).await;
    });

    // Run Strategy (Blocking/Pinned)
    // In a real scenario, this would be in a separate thread pinned to a core
    thread::spawn(move || {
        strategy::run_strategy(strategy_cons, strategy_prod);
    });

    // Keep main alive
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
    }
}
