use reqwest::Client;
use serde_json::Value;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new();
    let url = "https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=1&order=liquidity&descending=true";
    
    println!("Fetching {}", url);
    let resp = client.get(url).send().await?;
    let text = resp.text().await?;
    
    let v: Value = serde_json::from_str(&text)?;
    
    if let Some(arr) = v.as_array() {
        if let Some(first) = arr.first() {
            println!("First market keys:");
            if let Some(obj) = first.as_object() {
                for key in obj.keys() {
                    println!("- {}", key);
                }
                
                // Check specific fields
                println!("\nValues:");
                println!("conditionId: {:?}", first.get("conditionId"));
                println!("condition_id: {:?}", first.get("condition_id"));
                println!("questionID: {:?}", first.get("questionID"));
                println!("question_id: {:?}", first.get("question_id"));
                println!("minimumTickSize: {:?}", first.get("minimumTickSize"));
                println!("minimum_tick_size: {:?}", first.get("minimum_tick_size"));
            }
        }
    }
    
    Ok(())
}
