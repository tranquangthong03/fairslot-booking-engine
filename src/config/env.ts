
import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
    NODE_ENV: z.enum([
        "development",
        "test",
        "production",
    ]).default("development"),

    PORT: z.coerce.number().int().min(1).max(65535)
        .default(3000),

    DB_HOST: z.string().min(1),

    DB_PORT: z.coerce.number().int().min(1).max(65535),

    DB_USER: z.string().min(1),

    DB_PASSWORD: z.string().min(1),

    DB_NAME: z.string().min(1),
});

export const env = envSchema.parse(process.env);
