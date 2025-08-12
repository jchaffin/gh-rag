import MiniSearch from "minisearch";
import fs from "fs/promises";
import path from "path";
import { OpenAI } from "openai";

// Simple in-memory TTL cache
type CacheEntry<T> = { value: T; expires: number };
const embedCache = new Map<string, CacheEntry<number[]>>();
const searchCache = new Map<string, CacheEntry<any[]>>();
const NOW = () => Date.now();
function getCache<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.expires < NOW()) { map.delete(key); return undefined; }
  return hit.value;
}
function setCache<T>(map: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number) {
  map.set(key, { value, expires: NOW() + ttlMs });
}

type Cfg = { workdir: string; openaiApiKey: string; pine: { index: any } };
const DEBUG = !!process.env.DEBUG;

async function readBM25IfExists(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
async function loadMini(repoPath: string) {
  const file = path.join(repoPath, ".bm25.jsonl");
  const content = await readBM25IfExists(file);
  if (!content) return null;
  
  const lines = content.trim().split("\n");
  const docs = lines.map(l => JSON.parse(l));
  const mini = new MiniSearch({
    fields: ["text"],
    storeFields: ["text"],
    idField: "id"
  });
  mini.addAll(docs);
  return mini;
}

async function embedQuery(openaiApiKey: string, query: string) {
  const model = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-large";
  const cacheKey = `${model}|${query}`;
  const cached = getCache(embedCache, cacheKey);
  if (cached) return cached;
  const openai = new OpenAI({ apiKey: openaiApiKey });
  const r = await openai.embeddings.create({ model, input: query });
  const vec = r.data[0].embedding;
  // Cache embeddings briefly to smooth bursts
  setCache(embedCache, cacheKey, vec, 60_000);
  return vec;
}

function rrf(
  a: { id: string; score: number }[],
  b: { id: string; score: number }[],
  k = 60
) {
  const rank = (arr: any[]) =>
    Object.fromEntries(arr.map((x, i) => [x.id, i + 1]));
  const ra = rank(a);
  const rb = rank(b);
  const ids = new Set([...a.map(x => x.id), ...b.map(x => x.id)]);
  // @ts-ignore: ignore downlevel iteration warning for Set spread
  return [...ids]
    .map(id => ({
      id,
      score:
        1 / (k + (ra[id] || 999)) + 1 / (k + (rb[id] || 999))
    }))
    .sort((x, y) => y.score - x.score);
}

export async function hybridSearch(
  { workdir, openaiApiKey, pine, repo, query }: Cfg & { repo: string; query: string }
) {
  const repoPath = path.join(workdir, repo);
  if (DEBUG) console.log("Search path:", repoPath);
  
  // Short-lived result cache for identical queries
  const skey = `${repo}|${query}`;
  const cached = getCache<any[]>(searchCache, skey);
  if (cached) return cached;

  const mini = await loadMini(repoPath);
  if (DEBUG) console.log("Mini search loaded:", !!mini);

  // BM25
  const bm = mini
    ? mini
        .search(query, { prefix: true })
        .slice(0, 40)
        .map(r => ({ id: r.id, score: r.score }))
    : [];
  if (DEBUG) console.log("BM25 results:", bm.length);

  // Pinecone KNN
  if (DEBUG) console.log("Searching for repo:", repo);
  const vec = await embedQuery(openaiApiKey, query);
  if (DEBUG) console.log("Vector length:", vec.length);
  
  const pineResults = await pine.index.query({
    vector: vec,
    topK: 40,
    includeMetadata: true,
    filter: { repo: { $eq: repo } }
  });
  if (DEBUG) console.log("Pinecone results:", pineResults);
  if (DEBUG) console.log("Pinecone matches:", pineResults.matches?.length || 0);
  
  const knn = (pineResults.matches || []).map((m: any) => ({
    id: m.id as string,
    score: m.score || 0
  }));
  if (DEBUG) console.log("KNN results:", knn.length);

  // Fuse
  const fused = rrf(bm, knn).slice(0, 20);

  // Map IDs back to metadata
  const metaById = Object.fromEntries(
    (pineResults.matches || []).map((m: any) => [m.id as string, m.metadata])
  );

  if (DEBUG) console.log("First metadata example:", pineResults.matches?.[0]?.metadata);
  if (DEBUG) console.log("Metadata mapping keys:", Object.keys(metaById));
  if (DEBUG) console.log("Metadata mapping:", metaById);
  if (DEBUG) console.log("Fused results:", fused);

  const results = fused.map(f => metaById[f.id]).filter(Boolean);
  setCache(searchCache, skey, results, 10_000); // 10s TTL
  return results;
}
