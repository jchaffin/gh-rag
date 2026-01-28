// src/pine.ts
import { Pinecone } from "@pinecone-database/pinecone";
import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
import type { PCVector } from "./types";

export type { PCVector };

if (existsSync(resolve(process.cwd(), ".env.local"))) {
  loadEnv({ path: resolve(process.cwd(), ".env.local"), override: true });
} else {
  loadEnv(); // fallback to .env
}

const DEFAULTS = {
  index: process.env.PINECONE_INDEX ?? "repo-chunks",
  cloud: (process.env.PINECONE_CLOUD as "aws" | "gcp") ?? "aws",
  region: process.env.PINECONE_REGION ?? "us-east-1",
  metric: (process.env.PINECONE_METRIC as "cosine" | "dotproduct" | "euclidean") ?? "cosine",
  // Set one of: EMBEDDING_DIM or EMBEDDING_MODEL
  dim:
    (process.env.EMBEDDING_DIM && Number(process.env.EMBEDDING_DIM)) ||
    modelToDim(process.env.OPENAI_EMBED_MODEL ?? process.env.EMBEDDING_MODEL) ||
    1536, // sane default if you use text-embedding-3-small
};

function modelToDim(model?: string | null) {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("3-large")) return 3072;
  if (m.includes("3-small")) return 1536;
  if (m.includes("ada-002")) return 1536;
  return undefined;
}

let _pc: Pinecone | null = null;

/** Singleton Pinecone client */
export function pinecone(): Pinecone {
  if (_pc) return _pc;
  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) throw new Error("PINECONE_API_KEY missing");
  _pc = new Pinecone({ apiKey });
  return _pc;
}

/** Ensure serverless index exists with the given dimension */
export async function ensureIndex(params?: {
  name?: string;
  dimension?: number;
  metric?: "cosine" | "dotproduct" | "euclidean";
  cloud?: "aws" | "gcp";
  region?: string;
}) {
  const name = params?.name ?? DEFAULTS.index;
  const dimension = params?.dimension ?? DEFAULTS.dim;
  const metric = params?.metric ?? DEFAULTS.metric;
  const cloud = params?.cloud ?? DEFAULTS.cloud;
  const region = params?.region ?? DEFAULTS.region;

  const pc = pinecone();

  // Describe first. Create if missing or mismatched dim.
  let needCreate = false;
  try {
    const desc = await pc.describeIndex(name);
    const currentDim = desc.dimension;
    if (currentDim !== dimension) {
      throw new Error(
        `Index "${name}" dimension ${currentDim} != required ${dimension}. Create a new index or change EMBEDDING_DIM.`
      );
    }
  } catch (e: any) {
    if (String(e?.message || "").toLowerCase().includes("not found")) {
      needCreate = true;
    } else if (String(e).includes("Index not found")) {
      needCreate = true;
    } else {
      throw e;
    }
  }

  if (needCreate) {
    await pc.createIndex({
      name,
      dimension,
      metric,
      spec: { serverless: { cloud, region } },
    });
    // optional: small wait until ready
    await waitReady(name);
  }

  return name;
}

async function waitReady(name: string) {
  const pc = pinecone();
  for (let i = 0; i < 30; i++) {
    try {
      await pc.describeIndex(name);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  // continue anyway; serverless becomes ready quickly
}

/** Get a namespaced index handle (auto-ensure) */
export async function getNamespace(ns?: string) {
  const name = await ensureIndex();
  const pc = pinecone();
  return pc.index(name).namespace(ns ?? "default");
}

/** Upsert vectors in batches */
export async function upsert(
  vectors: PCVector[],
  opts?: { namespace?: string; batchSize?: number }
) {
  const ns = await getNamespace(opts?.namespace);
  const B = opts?.batchSize ?? 100;
  for (let i = 0; i < vectors.length; i += B) {
    const batch = vectors.slice(i, i + B);
    await ns.upsert(batch);
  }
}

/** Query topK with optional metadata filter */
export async function query(
  vector: number[],
  opts?: {
    topK?: number;
    namespace?: string;
    filter?: Record<string, any>;
    includeValues?: boolean;
    includeMetadata?: boolean;
  }
): Promise<any[]> {
  const ns = await getNamespace(opts?.namespace);
  const res = await ns.query({
    vector,
    topK: opts?.topK ?? 10,
    filter: opts?.filter,
    includeValues: opts?.includeValues ?? false,
    includeMetadata: opts?.includeMetadata ?? true,
  });
  return res.matches ?? [];
}