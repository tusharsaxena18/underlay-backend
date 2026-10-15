// src\config\dbConn.ts
import * as dotenv from "dotenv";
import { MongoClient, type Db } from "mongodb";

dotenv.config();

let client: MongoClient | null = null;
let database: Db | null = null;

export async function connectDb(): Promise<Db> {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        throw new Error("MONGO_URI is not defined in environment variables");
    }

    const dbName = process.env.MONGO_DB_NAME ?? "underlay";
    if (!client) {
        client = new MongoClient(mongoUri);
        await client.connect();
    }

    database = client.db(dbName);
    return database;
}

export async function getDb(): Promise<Db> {
    if (!database) {
        return connectDb();
    }

    return database;
}

export async function closeDb(): Promise<void> {
    if (client) {
        await client.close();
        client = null;
        database = null;
    }
}

export const connectDB = connectDb;
export const getDB = getDb;