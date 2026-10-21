
import express from "express";
import helmet from "helmet";
import { healthRouter } from "./modules/health/health.routes.js";

export const app = express();

app.use(helmet());
app.use(express.json({ limit: "1mb" }));

app.use("/api/v1", healthRouter);

app.use((_req, res) => {
    res.status(404).json({
        message: "Route not found",
    });
});
