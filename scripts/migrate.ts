
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "pg";

import { env } from "../src/config/env.js";

const migrationDir = resolve(
    process.cwd(),
    "migrations"
);

const filenamePattern = /^\d{14}_[a-z0-9_]+\.sql$/;

async function migrate(): Promise<void> {
    if (env.DB_NAME === "fairslot_lab") {
        throw new Error(
            "Cannot run production migrations on fairslot_lab"
        );
    }

    const filenames = (await readdir(migrationDir))
        .filter((name) => name.endsWith(".sql"))
        .sort();

    if (filenames.length === 0) {
        throw new Error("No SQL migrations found");
    }

    const migrations = [];

    for (const filename of filenames) {
        if (!filenamePattern.test(filename)) {
            throw new Error(`Invalid filename: ${filename}`);
        }

        const sql = await readFile(
            resolve(migrationDir, filename),
            "utf8"
        );

        if (!sql.trim()) {
            throw new Error(`Empty migration: ${filename}`);
        }

        migrations.push({
            version: filename,
            sql,
            checksum: createHash("sha256")
                .update(sql)
                .digest("hex"),
        });
    }

    const client = new Client({
        host: env.DB_HOST,
        port: env.DB_PORT,
        user: env.DB_USER,
        password: env.DB_PASSWORD,
        database: env.DB_NAME,
    });

    let connected = false;
    let locked = false;

    try {
        await client.connect();
        connected = true;

        // Only one migration runner can proceed.
        await client.query(
            "SELECT pg_advisory_lock(2026, 203)"
        );
        locked = true;

        await client.query(`
      CREATE TABLE IF NOT EXISTS
      public.schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW()
      )
    `);

        const result = await client.query<{
            version: string;
            checksum: string;
        }>(`
      SELECT version, checksum
      FROM public.schema_migrations
      ORDER BY version
    `);

        const applied = new Map(
            result.rows.map((row) => [
                row.version,
                row.checksum,
            ])
        );

        // Validate migration history before applying anything.
        for (const [version, checksum] of applied) {
            const file = migrations.find(
                (item) => item.version === version
            );

            if (!file) {
                throw new Error(
                    `Applied migration missing from source: ${version}`
                );
            }

            if (file.checksum !== checksum) {
                throw new Error(
                    `Applied migration was modified: ${version}`
                );
            }
        }

        const latestApplied = [...applied.keys()]
            .sort()
            .at(-1);

        for (const migration of migrations) {
            if (applied.has(migration.version)) {
                console.log(`Skipped: ${migration.version}`);
                continue;
            }

            if (
                latestApplied &&
                migration.version < latestApplied
            ) {
                throw new Error(
                    `Out-of-order migration: ${migration.version}`
                );
            }

            console.log(`Applying: ${migration.version}`);

            await client.query("BEGIN");

            try {
                await client.query(migration.sql);

                await client.query(
                    `INSERT INTO public.schema_migrations
           (version, checksum)
           VALUES ($1, $2)`,
                    [migration.version, migration.checksum]
                );

                await client.query("COMMIT");

                console.log(`Applied: ${migration.version}`);
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            }
        }

        console.log("All migrations are up to date.");
    } finally {
        try {
            if (locked) {
                await client.query(
                    "SELECT pg_advisory_unlock(2026, 203)"
                );
            }
        } finally {
            if (connected) {
                await client.end();
            }
        }
    }
}

migrate().catch((error: unknown) => {
    console.error("Migration failed:", error);
    process.exitCode = 1;
});
