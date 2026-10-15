// src\services\persistence\visibilityRunRepository.ts
import type { Db, ObjectId } from "mongodb";
import type { AIVisibilityInput, AIVisibilityOutput } from "../../types/schema";

export type VisibilityTier = "1" | "2" | "3";
export type VisibilityRunStatus = "success" | "partial" | "failed";
export type RawResponseStatus = "success" | "error" | "timeout" | "skipped";

export interface RawResponseDocument {
    response_id: string;
    run_id: string;
    query_id: string;
    provider: string;
    status: RawResponseStatus;
    response_text?: string | undefined;
    citations?: string[] | undefined;
    latency_ms?: number | undefined;
    error_code?: string | undefined;
    captured_at: string;
}

export interface ParsedResultDocument {
    response_id: string;
    run_id: string;
    query_id: string;
    provider: string;
    startup_mentioned: boolean;
    mention_count: number;
    first_mention_position?: number | null | undefined;
    position_score?: number | null | undefined;
    sentiment: string;
    framing: string;
    claims: Array<{
        field?: string | undefined;
        claim?: string | undefined;
        polarity?: "supports" | "contradicts" | "neutral" | undefined;
        matches_ground_truth?: "yes" | "no" | "unknown" | undefined;
        evidence_quote?: string | undefined;
        confidence?: number | undefined;
    }>;
    citations: string[];
    parse_confidence: number;
}

export interface VisibilityRunDocument {
    run_id: string;
    startup_id: string;
    startup_name: string;
    tier: VisibilityTier;
    scoring_version: string;
    started_at: string;
    completed_at: string;
    input_snapshot: AIVisibilityInput;
    raw_response_ids: string[];
    parsed_result_ids: string[];
    output: AIVisibilityOutput;
    status: VisibilityRunStatus;
}

export interface VisibilityRunRecord extends VisibilityRunDocument {
    record_id: string;
}

export interface PersistManyResult {
    inserted: number;
    errors: string[];
}

export class DuplicateRunError extends Error {
    public readonly run_id: string;

    constructor(runId: string) {
        super(`Duplicate run id: ${runId}`);
        this.name = "DuplicateRunError";
        this.run_id = runId;
    }
}

export interface VisibilityRunRepository {
    ensureIndexes(): Promise<void>;
    saveRawResponses(rawResponses: RawResponseDocument[]): Promise<PersistManyResult>;
    saveParsedResults(parsedResults: ParsedResultDocument[]): Promise<PersistManyResult>;
    saveRun(run: VisibilityRunDocument): Promise<{ record_id: string }>;
    getRunById(runId: string): Promise<VisibilityRunRecord | null>;
    getLatestRunForStartup(startupId: string): Promise<VisibilityRunRecord | null>;
}

function normaliseRecord<T extends Record<string, unknown>>(document: T | null): (T & { record_id: string }) | null {
    if (!document) {
        return null;
    }

    const { _id, ...rest } = document as T & { _id?: ObjectId };
    return {
        ...rest,
        record_id: _id ? _id.toString() : "",
    } as T & { record_id: string };
}

export function createVisibilityRunRepository(db: Db): VisibilityRunRepository {
    const runsCollection = db.collection<VisibilityRunDocument & { _id?: ObjectId }>("visibility_runs");
    const rawResponsesCollection = db.collection<RawResponseDocument & { _id?: ObjectId }>("visibility_raw_responses");
    const parsedResultsCollection = db.collection<ParsedResultDocument & { _id?: ObjectId }>("visibility_parsed_results");

    async function ensureCollectionIndexes(): Promise<void> {
        await runsCollection.createIndex({ run_id: 1 }, { unique: true });
        await runsCollection.createIndex({ startup_id: 1, completed_at: -1 });

        await rawResponsesCollection.createIndex({ response_id: 1 }, { unique: true });
        await rawResponsesCollection.createIndex({ run_id: 1 });

        await parsedResultsCollection.createIndex({ response_id: 1 }, { unique: true });
        await parsedResultsCollection.createIndex({ run_id: 1 });
    }

    async function saveManyWithPartialSupport<T extends Record<string, unknown>>(
        collection: { insertMany: (documents: T[], options?: { ordered?: boolean }) => Promise<{ insertedCount?: number }> },
        documents: T[],
        collectionName: string,
    ): Promise<PersistManyResult> {
        if (documents.length === 0) {
            return { inserted: 0, errors: [] };
        }

        try {
            const result = await collection.insertMany(documents, { ordered: false });
            return {
                inserted: Number(result.insertedCount ?? documents.length),
                errors: [],
            };
        } catch (error) {
            const mongoError = error as {
                insertedCount?: number;
                result?: { insertedCount?: number };
                writeErrors?: Array<{ err?: { errmsg?: string } }>;
                errmsg?: string;
            };

            const inserted = Number(
                mongoError.result?.insertedCount ?? mongoError.insertedCount ?? 0,
            );
            const errors = (mongoError.writeErrors ?? []).map(
                (entry) => entry.err?.errmsg ?? `${collectionName}_insert_failed`,
            );

            if (errors.length === 0 && mongoError.errmsg) {
                errors.push(mongoError.errmsg);
            }

            return {
                inserted: Math.max(0, inserted),
                errors,
            };
        }
    }

    return {
        async ensureIndexes(): Promise<void> {
            await ensureCollectionIndexes();
        },

        async saveRawResponses(rawResponses: RawResponseDocument[]): Promise<PersistManyResult> {
            return saveManyWithPartialSupport(rawResponsesCollection, rawResponses, "visibility_raw_responses");
        },

        async saveParsedResults(parsedResults: ParsedResultDocument[]): Promise<PersistManyResult> {
            return saveManyWithPartialSupport(parsedResultsCollection, parsedResults, "visibility_parsed_results");
        },

        async saveRun(run: VisibilityRunDocument): Promise<{ record_id: string }> {
            const existing = await runsCollection.findOne({ run_id: run.run_id });
            if (existing) {
                throw new DuplicateRunError(run.run_id);
            }

            const result = await runsCollection.insertOne(run as VisibilityRunDocument & { _id?: ObjectId });
            return { record_id: result.insertedId.toString() };
        },

        async getRunById(runId: string): Promise<VisibilityRunRecord | null> {
            const document = await runsCollection.findOne({ run_id: runId });
            return normaliseRecord(document as Record<string, unknown> | null) as VisibilityRunRecord | null;
        },

        async getLatestRunForStartup(startupId: string): Promise<VisibilityRunRecord | null> {
            const document = await runsCollection
                .find({ startup_id: startupId })
                .sort({ completed_at: -1 })
                .limit(1)
                .next();

            return normaliseRecord(document as Record<string, unknown> | null) as VisibilityRunRecord | null;
        },
    };
}
