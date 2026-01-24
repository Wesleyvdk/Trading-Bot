
import "./env_setup";
import { initDataTables, insertStrategyLog, getDb } from "./db";

async function main() {
    console.log("Testing DB connection...");
    try {
        await initDataTables();
        console.log("Tables initialized.");

        console.log("Inserting strategy log...");
        await insertStrategyLog(1, 100000, 0.01, 0.02, 1);
        console.log("Strategy log inserted.");
        
        process.exit(0);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}

main();
