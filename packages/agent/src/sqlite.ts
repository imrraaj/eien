import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
    SqliteStorage,
    type SqliteDatabase,
    type SqliteExecutor,
    type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

/** Runs statements on one connection; `db.query` caches prepared statements by SQL text. */
class BunSqliteExecutor implements SqliteExecutor {
    constructor(protected readonly db: Database) {}

    protected async perform<T>(operation: () => T): Promise<T> {
        return operation();
    }

    exec(sql: string): Promise<void> {
        return this.perform(() => void this.db.exec(sql));
    }

    run(sql: string, ...params: SqliteValue[]): Promise<void> {
        return this.perform(() => void this.db.query(sql).run(...params));
    }

    runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
        return this.perform(() => this.db.query(sql).run(...params).changes);
    }

    get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
        return this.perform(() => (this.db.query(sql).get(...params) as T | null) ?? undefined);
    }

    all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
        return this.perform(() => this.db.query(sql).all(...params) as T[]);
    }
}

/** Transaction handle: usable only while its callback runs. */
class BunSqliteTransaction extends BunSqliteExecutor {
    active = true;

    protected override async perform<T>(operation: () => T): Promise<T> {
        if (!this.active) throw new Error("SQLite transaction handle is no longer active");
        return operation();
    }
}

/**
 * pi-durable's portable `SqliteDatabase` over `bun:sqlite` (Bun has no `node:sqlite`).
 * Every operation queues behind the previous one, so nothing interleaves with an open
 * transaction, as the facade contract requires.
 */
class BunSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
    #tail: Promise<unknown> = Promise.resolve();

    protected override perform<T>(operation: () => T | Promise<T>): Promise<T> {
        const result = this.#tail.then(operation);
        this.#tail = result.catch(() => undefined);
        return result;
    }

    transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
        return this.perform(async () => {
            this.db.exec("BEGIN IMMEDIATE");
            const handle = new BunSqliteTransaction(this.db);
            try {
                const result = await callback(handle);
                handle.active = false;
                this.db.exec("COMMIT");
                return result;
            } catch (error) {
                handle.active = false;
                try {
                    this.db.exec("ROLLBACK");
                } catch (rollbackError) {
                    throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
                }
                throw error;
            }
        });
    }

    close(): Promise<void> {
        return this.perform(() => {
            try {
                this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            } finally {
                this.db.close();
            }
        });
    }
}

/** Open (or create) durable storage in one SQLite file. */
export async function openSqliteStorage(path: string): Promise<SqliteStorage> {
    await mkdir(dirname(path), { recursive: true });
    const db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    return SqliteStorage.open(new BunSqliteDatabase(db));
}
