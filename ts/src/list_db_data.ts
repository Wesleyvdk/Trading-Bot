
import "./env_setup";
import { getDb } from "./db";

async function main() {
    console.log("Env keys:", Object.keys(process.env));
    const sql = getDb();

    // Get all tables
    const tables = await sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name;
    `;

    console.log("DATABASE_CONTENT_START");

    for (const table of tables) {
        const tableName = table.table_name;
        console.log(`TABLE: ${tableName}`);

        // Get count
        const countResult = await sql`SELECT COUNT(*) as c FROM ${sql(tableName)}`;
        const count = countResult[0].c;
        console.log(`COUNT: ${count}`);

        // Get sample data (limit 3)
        if (count > 0) {
            const rows = await sql`SELECT * FROM ${sql(tableName)} ORDER BY id DESC LIMIT 3`;
            console.log("SAMPLE_ROWS:");
            console.log(JSON.stringify(rows, null, 2));
        }
        console.log("TABLE_END");
    }
    console.log("DATABASE_CONTENT_END");

    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
