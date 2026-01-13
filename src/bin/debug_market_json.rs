use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Market {
    #[serde(rename = "conditionId")]
    pub condition_id: String,
    #[serde(default, rename = "questionID")]
    pub question_id: Option<String>,
    #[serde(rename = "clobTokenIds")]
    pub clob_token_ids: String, // JSON string: "[\"id1\", \"id2\"]"
    pub outcomes: String,       // JSON string: "[\"Yes\", \"No\"]"
    pub active: bool,
    pub closed: bool,
    pub question: Option<String>,
    #[serde(default)]
    pub neg_risk: Option<bool>,
    #[serde(default)]
    pub minimum_tick_size: Option<f64>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()?;
        
    let url = "https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=10&order=liquidity&descending=true";
    
    println!("Fetching {}", url);
    let resp = client.get(url).send().await?;
    let text = resp.text().await?;
    
    // Try to deserialize into Vec<Market>
    match serde_json::from_str::<Vec<Market>>(&text) {
        Ok(markets) => {
            println!("✅ Successfully deserialized {} markets!", markets.len());
            if let Some(first) = markets.first() {
                println!("First market: {:?}", first);
                println!("ClobTokenIds: {}", first.clob_token_ids);
                println!("Outcomes: {}", first.outcomes);
            }
        },
        Err(e) => {
            println!("❌ Failed to deserialize: {}", e);
            // Print a snippet of JSON to debug
            println!("JSON snippet: {}", &text[0..500.min(text.len())]);
        }
    }
    
    Ok(())
}
