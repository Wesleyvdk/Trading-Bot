
import * as dotenv from "dotenv";
import path from "path";
// Hardcode path to be sure
dotenv.config({ path: "i:\\NuvoraProjects\\TradingBot\\.env" });
console.log("Env loaded. DATABASE_URL exists:", !!process.env.DATABASE_URL);
