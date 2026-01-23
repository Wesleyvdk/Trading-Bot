// Data Collection Runner
// Run this to start collecting price data for pattern analysis
// Usage: bun run src/run_collector.ts

import { startDataCollection } from "./data_collector";

console.log(`
╔══════════════════════════════════════════════════════════════╗
║           POLYMARKET DATA COLLECTOR                          ║
║                                                              ║
║   This will continuously collect:                            ║
║   • BTC prices from Binance (every 5 seconds)                ║
║   • Share prices from Polymarket (every 30 seconds)          ║
║   • Market outcomes when windows close                       ║
║                                                              ║
║   Run for 7-14 days to build enough data for analysis.       ║
║   Press Ctrl+C to stop.                                      ║
╚══════════════════════════════════════════════════════════════╝
`);

startDataCollection().catch(console.error);
