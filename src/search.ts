// Minisearch is ESM-only in newer versions, which breaks CJS require.
// We lazy-load it via native dynamic import to support both.
let MiniSearchCtor: any | null = null;
async function loadMiniSearchCtor() {
  if (MiniSearchCtor) return MiniSearchCtor;
  try {
    // Use Function constructor to avoid TS downleveling import() to require()
    // which would fail for ESM-only packages.
    const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;
    const mod = await dynamicImport("minisearch");
    MiniSearchCtor = mod.default ?? mod;
    return MiniSearchCtor;
  } catch (err) {
    if (process.env.DEBUG) {
      console.warn("MiniSearch unavailable; BM25 disabled:", (err as Error)?.message);
    }
    MiniSearchCtor = null;
    return null;
  }
}
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

import type { FindBySkillOpts, ProjectMatch } from "./types";

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
  const Mini = await loadMiniSearchCtor();
  if (!Mini) return null; // gracefully skip BM25 if minisearch can't load

  const lines = content.trim().split("\n");
  const docs = lines.map(l => JSON.parse(l));
  const mini = new Mini({
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
  { workdir, openaiApiKey, pine, repo, query }: Cfg & { repo?: string; query: string }
) {
  // Short-lived result cache for identical queries
  const skey = `${repo || '_all'}|${query}`;
  const cached = getCache<any[]>(searchCache, skey);
  if (cached) return cached;

  // BM25 local search only works when a specific repo is provided
  let bm: { id: string; score: number }[] = [];
  if (repo) {
    const repoPath = path.join(workdir, repo);
    if (DEBUG) console.log("Search path:", repoPath);
    const mini = await loadMini(repoPath);
    if (DEBUG) console.log("Mini search loaded:", !!mini);
    bm = mini
      ? mini
          .search(query, { prefix: true })
          .slice(0, 40)
          .map((r: any) => ({ id: r.id, score: r.score }))
      : [];
    if (DEBUG) console.log("BM25 results:", bm.length);
  }

  // Pinecone KNN — use repo's namespace when specified
  if (DEBUG) console.log("Searching for repo:", repo || "(all repos)");
  const vec = await embedQuery(openaiApiKey, query);
  if (DEBUG) console.log("Vector length:", vec.length);
  
  const pineQuery: any = {
    vector: vec,
    topK: repo ? 40 : 80,
    includeMetadata: true,
  };
  
  // Query the repo's namespace if specified, otherwise query default namespace
  const indexToQuery = repo ? pine.index.namespace(repo) : pine.index;
  const pineResults = await indexToQuery.query(pineQuery);
  if (DEBUG) console.log("Pinecone results:", pineResults);
  if (DEBUG) console.log("Pinecone matches:", pineResults.matches?.length || 0);
  
  const knn = (pineResults.matches || []).map((m: any) => ({
    id: m.id as string,
    score: m.score || 0
  }));
  if (DEBUG) console.log("KNN results:", knn.length);

  // Fuse (BM25 may be empty when searching all repos)
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

/**
 * Find projects that use a specific skill/technology.
 * Searches across all repos using semantic search on the skill name,
 * then groups and ranks results by repo.
 */
export async function findProjectsBySkill(
  { openaiApiKey, pine, skill, limit = 20 }: Omit<Cfg, "workdir"> & FindBySkillOpts
): Promise<ProjectMatch[]> {
  // Cache key for this skill search
  const cacheKey = `skill:${skill}`;
  const cached = getCache<ProjectMatch[]>(searchCache, cacheKey);
  if (cached) return cached;

  // Embed the skill/technology name for semantic search
  const vec = await embedQuery(openaiApiKey, skill);
  if (DEBUG) console.log(`Searching for skill: "${skill}"`);

  // Query Pinecone without repo filter to search across all projects
  const pineResults = await pine.index.query({
    vector: vec,
    topK: 100, // Get more results to aggregate by repo
    includeMetadata: true,
  });

  if (DEBUG) console.log("Pinecone matches:", pineResults.matches?.length || 0);

  // Group results by repo
  const repoMap = new Map<string, {
    score: number;
    techStack: Set<string>;
    paths: Set<string>;
    matchCount: number;
  }>();

  for (const match of pineResults.matches || []) {
    const meta = match.metadata as any;
    if (!meta?.repo) continue;

    const repo = meta.repo as string;
    
    // Handle both array format (new) and comma-separated string format (legacy)
    let techStackArr: string[];
    if (Array.isArray(meta.techStack)) {
      techStackArr = meta.techStack;
    } else {
      const techStackStr = (meta.techStack as string) || "";
      techStackArr = techStackStr.split(",").map((s: string) => s.trim()).filter(Boolean);
    }

    // Check if this repo's techStack contains the skill (case-insensitive)
    const skillLower = skill.toLowerCase();
    const hasSkill = techStackArr.some((t: string) => 
      t.toLowerCase().includes(skillLower) || skillLower.includes(t.toLowerCase())
    );

    // Boost score if techStack explicitly contains the skill
    const scoreBoost = hasSkill ? 1.5 : 1.0;
    const adjustedScore = (match.score || 0) * scoreBoost;

    const existing = repoMap.get(repo);
    if (existing) {
      existing.score = Math.max(existing.score, adjustedScore);
      existing.matchCount++;
      techStackArr.forEach((t: string) => existing.techStack.add(t));
      if (meta.path) existing.paths.add(meta.path);
    } else {
      repoMap.set(repo, {
        score: adjustedScore,
        techStack: new Set(techStackArr),
        paths: new Set(meta.path ? [meta.path] : []),
        matchCount: 1,
      });
    }
  }

  // Convert to array and sort by score
  const results: ProjectMatch[] = Array.from(repoMap.entries())
    .map(([repo, data]) => ({
      repo,
      techStack: Array.from(data.techStack),
      score: data.score,
      samplePaths: Array.from(data.paths).slice(0, 5),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Cache results
  setCache(searchCache, cacheKey, results, 30_000); // 30s TTL
  return results;
}
