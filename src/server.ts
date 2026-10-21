
import { app } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./database/pool.js";

async function startServer() {
    try {
        await pool.query("SELECT 1");

        console.log("Database connected successfully");

        app.listen(env.PORT, () => {
            console.log(
                `Server running at http://localhost:${env.PORT}`
            );
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        await pool.end();
        process.exit(1);
    }
}

startServer();
