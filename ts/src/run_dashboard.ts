// Dashboard Server
// Serves the data dashboard UI and API

import { startDashboardApi } from "./dashboard_api";
import { initDataTables } from "./db";
import path from "path";

const DASHBOARD_PORT = 3000;

async function main() {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║           POLYMARKET DATA DASHBOARD                          ║
╚══════════════════════════════════════════════════════════════╝
`);

    // Initialize database
    await initDataTables();

    // Start API server
    startDashboardApi();

    // Serve dashboard HTML
    const dashboardPath = path.resolve(__dirname, "../dashboard/index.html");

    Bun.serve({
        port: DASHBOARD_PORT,
        async fetch(req) {
            const url = new URL(req.url);

            if (url.pathname === "/" || url.pathname === "/index.html") {
                const file = Bun.file(dashboardPath);
                return new Response(file, {
                    headers: { "Content-Type": "text/html" }
                });
            }

            return new Response("Not found", { status: 404 });
        }
    });

    console.log(`\n🌐 Dashboard running at http://localhost:${DASHBOARD_PORT}`);
    console.log(`📊 API running at http://localhost:3001`);
    console.log(`\nOpen http://localhost:${DASHBOARD_PORT} in your browser to view the dashboard.`);
}

main().catch(console.error);
