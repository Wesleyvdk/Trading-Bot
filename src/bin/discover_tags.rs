use reqwest::Client;
use serde_json::Value;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new();
    
    println!("🔍 Fetching top 1000 active markets by LIQUIDITY...");
    let url = "https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=1000&order=liquidity&descending=true";

    let resp = client.get(url).send().await?;
    let text = resp.text().await?;
    let v: Value = serde_json::from_str(&text)?;
    
    let assets = vec!["Solana", "Ethereum", "XRP", "Bitcoin"];
    
    if let Some(array) = v.as_array() {
        println!("✅ Fetched {} markets.", array.len());
        
        for market in array {
            let question = market["question"].as_str().unwrap_or("");
            
            for &asset in &assets {
                if question.to_lowercase().contains(&asset.to_lowercase()) {
                    println!("\n🎯 Match for '{}': {}", asset, question);
                    println!("   ID: {}", market["id"]);
                }
            }
        }
    }

    Ok(())
}
