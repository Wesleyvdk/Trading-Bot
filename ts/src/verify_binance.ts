// @ts-nocheck
const https = require('https');

function fetchBinanceCandle(symbol, interval, startTime) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=1`;
    console.log("Fetching:", url);
    
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function verify() {
    // Jan 16, 2026 14:00:00 UTC (9AM ET)
    const startTime = new Date("2026-01-16T14:00:00Z").getTime();
    
    try {
        const candles = await fetchBinanceCandle("BTCUSDT", "1h", startTime);
        if (candles && candles.length > 0) {
            const candle = candles[0];
            const openTime = new Date(candle[0]).toISOString();
            const openPrice = parseFloat(candle[1]);
            
            console.log(`Time: ${openTime}`);
            console.log(`Open Price: ${openPrice}`);
            console.log(`Target was: 95448.86`);
            
            if (Math.abs(openPrice - 95448.86) < 1) {
                console.log("✅ MATCH CONFIRMED!");
            } else {
                console.log("❌ NO MATCH");
            }
        } else {
            console.log("No candle found");
        }
    } catch (e) {
        console.error("Error:", e);
    }
}

verify();
