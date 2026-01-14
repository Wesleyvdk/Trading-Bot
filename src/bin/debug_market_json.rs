use std::env;
use dotenv::dotenv;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv().ok();
    
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()?;
    
    println!("=== GAMMA API (Markets) ===\n");
    
    // Fetch Gamma API events
    let gamma_url = "https://gamma-api.polymarket.com/events?limit=5&active=true&closed=false";
    println!("Fetching: {}\n", gamma_url);
    
    let resp = client.get(gamma_url).send().await?;
    println!("Status: {}", resp.status());
    
    let json: serde_json::Value = resp.json().await?;
    
    // Print first event's structure
    if let Some(events) = json.as_array() {
        println!("Total events: {}\n", events.len());
        
        for (i, event) in events.iter().enumerate().take(2) {
            println!("--- Event {} ---", i);
            println!("  Title: {}", event.get("title").unwrap_or(&serde_json::Value::Null));
            println!("  Slug: {}", event.get("slug").unwrap_or(&serde_json::Value::Null));
            
            if let Some(markets) = event.get("markets").and_then(|m| m.as_array()) {
                println!("  Markets: {}", markets.len());
                
                for (j, market) in markets.iter().enumerate().take(1) {
                    println!("\n  --- Market {} ---", j);
                    println!("    id: {}", market.get("id").unwrap_or(&serde_json::Value::Null));
                    println!("    question: {}", market.get("question").unwrap_or(&serde_json::Value::Null));
                    println!("    conditionId: {}", market.get("conditionId").unwrap_or(&serde_json::Value::Null));
                    println!("    questionID: {}", market.get("questionID").unwrap_or(&serde_json::Value::Null));
                    println!("    outcomes: {}", market.get("outcomes").unwrap_or(&serde_json::Value::Null));
                    println!("    clobTokenIds: {}", market.get("clobTokenIds").unwrap_or(&serde_json::Value::Null));
                    println!("    active: {}", market.get("active").unwrap_or(&serde_json::Value::Null));
                    println!("    closed: {}", market.get("closed").unwrap_or(&serde_json::Value::Null));
                    println!("    endDate: {}", market.get("endDate").unwrap_or(&serde_json::Value::Null));
                }
            }
            println!();
        }
    }
    
    println!("\n=== CLOB API (Balance - requires auth) ===\n");
    
    // Test unauthenticated CLOB endpoints
    let clob_endpoints = vec![
        "https://clob.polymarket.com/alive",
        "https://clob.polymarket.com/time",
    ];
    
    for url in clob_endpoints {
        println!("Fetching: {}", url);
        let resp = client.get(url).send().await?;
        println!("  Status: {}", resp.status());
        if resp.status().is_success() {
            let text = resp.text().await?;
            println!("  Response: {}", &text[..text.len().min(200)]);
        }
        println!();
    }
    
    // To test authenticated balance endpoint, you would need to use polymarket-rs
    println!("Note: Balance endpoint requires L2 authentication.");
    println!("The bot uses polymarket-rs AuthenticatedClient for this.");
    println!("\nTo debug balance issues, check the bot logs for:");
    println!("  '📊 Balance API response: ...'");
    
    Ok(())
}
