/**
 * Unified Runner - Run both trading strategies simultaneously
 * 
 * Usage: bun run src/run_both.ts
 */

import { spawn, type Subprocess } from "bun";
import path from "path";

const srcDir = path.dirname(import.meta.path);

console.log("═".repeat(60));
console.log("   UNIFIED TRADING BOT RUNNER");
console.log("   Running: Momentum + Latency strategies");
console.log("═".repeat(60));
console.log("");

// Track processes for cleanup
const processes: Subprocess[] = [];

// Start momentum bot
console.log("🚀 Starting Momentum Bot...");
const momentum = spawn({
    cmd: ["bun", "run", path.join(srcDir, "index_v2.ts")],
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, BOT_NAME: "MOMENTUM" }
});
processes.push(momentum);

// Small delay to stagger startup
await new Promise(resolve => setTimeout(resolve, 2000));

// Start latency bot
console.log("🚀 Starting Latency Bot...");
const latency = spawn({
    cmd: ["bun", "run", path.join(srcDir, "latency_bot.ts")],
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, BOT_NAME: "LATENCY" }
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
