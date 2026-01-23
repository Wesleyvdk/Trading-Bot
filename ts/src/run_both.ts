/**
 * Unified Runner - Run both trading strategies simultaneously
 * 
 * Usage: bun run src/run_both.ts
 * 
 * Note: Each bot runs as a separate process with its own database connection
 */

import { spawn, type Subprocess } from "bun";
import path from "path";
import { initDataTables } from "./db";

const srcDir = path.dirname(import.meta.path);

console.log("═".repeat(60));
console.log("   UNIFIED TRADING BOT RUNNER");
console.log("   Running: Momentum + Latency strategies");
console.log("═".repeat(60));
console.log("");

// Track processes for cleanup
const processes: Subprocess[] = [];

async function main() {
    // Initialize database tables ONCE before starting bots
    console.log("📊 Initializing database tables...");
    try {
        await initDataTables();
        console.log("✅ Database ready\n");
    } catch (e) {
        console.error("❌ Database initialization failed:", e);
        process.exit(1);
    }

    // Start momentum bot with --no-collect to avoid duplicate data collection
    // (latency bot has its own Binance WebSocket)
    console.log("🚀 Starting Momentum Bot...");
    const momentum = spawn({
        cmd: ["bun", "run", path.join(srcDir, "index_v2.ts"), "--no-collect"],
        stdout: "inherit",
        stderr: "inherit"
    });
    processes.push(momentum);

    // Wait for momentum bot to initialize (5 seconds)
    console.log("⏳ Waiting for Momentum Bot to initialize...\n");
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Start latency bot
    console.log("🚀 Starting Latency Bot...");
    const latency = spawn({
        cmd: ["bun", "run", path.join(srcDir, "latency_bot.ts")],
        stdout: "inherit",
        stderr: "inherit"
    });
    processes.push(latency);

    // Handle shutdown
    process.on("SIGINT", () => {
        console.log("\n⚠️ Shutting down all bots...");
        for (const proc of processes) {
            proc.kill();
        }
        process.exit(0);
    });

    // Wait for both to exit
    const results = await Promise.allSettled([
        momentum.exited,
        latency.exited
    ]);

    console.log("\n📊 Bot Exit Summary:");
    console.log(`   Momentum: exit code ${results[0].status === 'fulfilled' ? results[0].value : 'error'}`);
    console.log(`   Latency: exit code ${results[1].status === 'fulfilled' ? results[1].value : 'error'}`);
}

main().catch(console.error);
