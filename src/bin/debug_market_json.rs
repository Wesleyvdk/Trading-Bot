use reqwest::Client;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()?;
        
    let base_clob = "https://clob.polymarket.com";
    let base_data = "https://data-api.polymarket.com";
    
    let endpoints = vec![
        (base_clob, "/balance"),
        (base_clob, "/balances"),
        (base_clob, "/user/balance"),
        (base_clob, "/user/balances"),
        (base_clob, "/account/balance"),
        (base_clob, "/account/balances"),
        (base_clob, "/utilities/balance-allowance"),
        (base_clob, "/balance-allowance"),
        (base_data, "/positions"),
        (base_data, "/balance"),
    ];
    
    for (base, path) in endpoints {
        let url = format!("{}{}", base, path);
        let resp = client.get(&url).send().await?;
        println!("{} -> {}", url, resp.status());
    }
    
    Ok(())
}
