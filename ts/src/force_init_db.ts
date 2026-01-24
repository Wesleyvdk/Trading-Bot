
import "./env_setup";
import { initDataTables, getDb } from "./db";

async function main() {
    console.log("Force initializing DB...");
    try {
        await initDataTables();
        console.log("Tables initialized.");
        
        const sql = getDb();
        const [result] = await sql`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'latency_logs'
            );
        `;
        console.log("latency_logs exists:", result.exists);
        
        process.exit(0);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}

main();
