use alloy::signers::local::PrivateKeySigner;
use alloy::signers::Signer;
use std::str::FromStr;
use rtrb::Consumer;

pub struct TradeInstruction {
    pub symbol: u64,
    pub side: u8, // 0 = Buy, 1 = Sell
    pub price: u64,
    pub size: u64,
}

pub async fn run_execution(mut consumer: Consumer<TradeInstruction>) {
    println!("Starting Execution Engine...");
    
    // Dummy Private Key (DO NOT USE IN PRODUCTION)
    let private_key = "0000000000000000000000000000000000000000000000000000000000000001";
    let signer = PrivateKeySigner::from_str(private_key).expect("Invalid private key");

    println!("Signer Address: {:?}", signer.address());

    loop {
        // Check for trade instructions
        if let Ok(trade) = consumer.pop() {
            println!("--------------------------------------------------");
            println!(" [DRY RUN] TRADE TRIGGERED!");
            println!(" Symbol: {}", trade.symbol);
            println!(" Side:   {}", if trade.side == 0 { "BUY YES" } else { "SELL YES" });
            println!(" Price:  ${:.2}", trade.price as f64 / 100.0);
            println!(" Size:   ${}", trade.size);
            
            // Pre-sign logic (Simulation)
            let message = format!("Buy YES at {}", trade.price).into_bytes();
            let signature = signer.sign_message(&message).await.expect("Signing failed");
            println!(" Signature: {:?}", signature);
            println!("--------------------------------------------------");
        }
        
        // Yield to avoid burning 100% CPU on this async thread
        tokio::task::yield_now().await;
    }
}
