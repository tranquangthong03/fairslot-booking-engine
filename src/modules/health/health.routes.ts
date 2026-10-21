
import { Router } from "express";
import { pool } from "../../database/pool.js";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
    try {
        await pool.query("SELECT 1");

        return res.status(200).json({
            status: "ok",
            database: "connected",
        });
    } catch (error) {
        console.error("Database health check failed:", error);

        return res.status(503).json({
            status: "error",
            database: "disconnected",
        });
    }
});
