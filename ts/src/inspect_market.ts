// @ts-nocheck
const https = require('https');

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

async function inspect() {
    const slug = "bitcoin-up-or-down-january-16-9am-et";
    const url = `https://gamma-api.polymarket.com/events?slug=${slug}`;
    console.log("Fetching from:", url);
    
    try {
        const events = await fetchUrl(url);
        
        if (events && events.length > 0) {
            console.log(`Found ${events.length} events`);
            for (const event of events) {
                console.log(`Event: ${event.title}`);
                if (event.title.includes("Up or Down")) {
                    console.log(`\n--- MATCH: ${event.title} ---`);
                    console.log("Description:", event.description);
                    if (event.markets && event.markets.length > 0) {
                        const market = event.markets[0];
                        console.log("\n--- Market JSON ---");
                        console.log(JSON.stringify(market, null, 2));
                        // console.log("Market Question:", market.question);
                        // console.log("Market Description:", market.description);
                    }
                }
            }
        } else {
            console.log("No events found");
        }
    } catch (e) {
        console.error("Error:", e);
    }
}

inspect();
