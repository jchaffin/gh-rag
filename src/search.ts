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
import pLimit from "p-limit";
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

const MAX_SKILL_SEARCH_NAMESPACES = 400;

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if `text` names the skill as a token (not a semantic guess). */
function skillNamedInChunkText(skill: string, text: string): boolean {
  const q = skill.trim();
  if (!q || !text) return false;
  try {
    const re = new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(q)}(?![A-Za-z0-9_])`, "i");
    return re.test(text);
  } catch {
    return text.toLowerCase().includes(q.toLowerCase());
  }
}

function techLabelNamesSkill(skill: string, techLabel: string): boolean {
  const s = skill.trim().toLowerCase();
  const tl = techLabel.toLowerCase();
  if (!s) return false;
  return tl.includes(s);
}

/** Namespaces that contain vectors (default `""` + per-repo namespaces from ingest). */
async function getNamespaceNames(index: any): Promise<string[]> {
  try {
    const stats = await index.describeIndexStats();
    const entries = Object.entries(stats.namespaces || {}) as [string, { recordCount?: number }][];
    if (entries.length > 0) {
      entries.sort((a, b) => (b[1]?.recordCount ?? 0) - (a[1]?.recordCount ?? 0));
      return entries.slice(0, MAX_SKILL_SEARCH_NAMESPACES).map(([name]) => name);
    }
  } catch (e) {
    if (DEBUG) console.warn("describeIndexStats failed:", (e as Error)?.message);
  }
  if (typeof index.listNamespaces === "function") {
    try {
      const res = await index.listNamespaces(100);
      const names = (res.namespaces || []).map((n: { name: string }) => n.name).filter(Boolean);
      if (names.length > 0) return names.slice(0, MAX_SKILL_SEARCH_NAMESPACES);
    } catch (e) {
      if (DEBUG) console.warn("listNamespaces failed:", (e as Error)?.message);
    }
  }
  return [""];
}

function indexForNamespace(index: any, ns: string) {
  return ns ? index.namespace(ns) : index;
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
  // Do not cache empty results — avoids "stuck" no-hit answers for ~10s right after ingest completes.
  if (results.length > 0) {
    setCache(searchCache, skey, results, 10_000); // 10s TTL
  }
  return results;
}

/**
 * Find projects that use a specific skill/technology.
 * Uses vector search only to locate candidate chunks; a repo is returned only if
 * the skill appears in ingest tech-stack labels or explicitly in chunk text (no semantic-only fallback).
 */
export async function findProjectsBySkill(
  { openaiApiKey, pine, skill, limit = 20 }: Omit<Cfg, "workdir"> & FindBySkillOpts
): Promise<ProjectMatch[]> {
  const skillTrim = skill.trim();
  const cacheKey = `skill:explicit:v1:${skillTrim}`;
  const cached = getCache<ProjectMatch[]>(searchCache, cacheKey);
  if (cached) return cached;

  const vec = await embedQuery(openaiApiKey, skillTrim);
  if (DEBUG) console.log(`Searching for skill: "${skillTrim}"`);

  const index = pine.index;
  const namespaces = await getNamespaceNames(index);
  if (DEBUG) console.log(`findProjectsBySkill: querying ${namespaces.length} namespace(s)`);

  const runLimited = pLimit(8);
  const topKPerNs = Math.max(
    16,
    Math.min(60, Math.ceil(280 / Math.max(1, namespaces.length))),
  );
  const matchLists = await Promise.all(
    namespaces.map((ns) =>
      runLimited(async () => {
        try {
          const target = indexForNamespace(index, ns);
          const res = await target.query({
            vector: vec,
            topK: topKPerNs,
            includeMetadata: true,
          });
          return res.matches || [];
        } catch (e) {
          if (DEBUG) console.warn(`query namespace "${ns}":`, (e as Error)?.message);
          return [];
        }
      })
    )
  );
  const allMatches = matchLists.flat();

  if (DEBUG) console.log("Pinecone matches (all namespaces):", allMatches.length);

  type Agg = {
    score: number;
    techStack: Set<string>;
    matchCount: number;
    evidencePathScore: Map<string, number>;
    techHints: Set<string>;
  };

  const repoMap = new Map<string, Agg>();

  for (const match of allMatches) {
    const meta = match.metadata as any;
    if (!meta?.repo) continue;

    const repo = meta.repo as string;

    let techStackArr: string[];
    if (Array.isArray(meta.techStack)) {
      techStackArr = meta.techStack;
    } else {
      const techStackStr = (meta.techStack as string) || "";
      techStackArr = techStackStr.split(",").map((s: string) => s.trim()).filter(Boolean);
    }

    const text = typeof meta.text === "string" ? meta.text : "";
    const textNamesSkill = text && skillNamedInChunkText(skillTrim, text);
    const stackHints = techStackArr.filter((t) => techLabelNamesSkill(skillTrim, t));
    const stackHit = stackHints.length > 0;
    if (!textNamesSkill && !stackHit) continue;

    const rawScore = match.score || 0;
    const adjustedScore = rawScore * (stackHit ? 1.5 : 1.0);

    const path = meta.path as string | undefined;
    const existing = repoMap.get(repo);
    if (existing) {
      existing.score = Math.max(existing.score, adjustedScore);
      existing.matchCount++;
      techStackArr.forEach((t: string) => existing.techStack.add(t));
      stackHints.forEach((t) => existing.techHints.add(t));
      if (textNamesSkill && path) {
        const prev = existing.evidencePathScore.get(path) ?? 0;
        if (adjustedScore > prev) existing.evidencePathScore.set(path, adjustedScore);
      }
    } else {
      const evidencePathScore = new Map<string, number>();
      if (textNamesSkill && path) evidencePathScore.set(path, adjustedScore);
      const techHints = new Set(stackHints);
      repoMap.set(repo, {
        score: adjustedScore,
        techStack: new Set(techStackArr),
        matchCount: 1,
        evidencePathScore,
        techHints,
      });
    }
  }

  const evidencePathsRanked = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p]) => p)
      .slice(0, 8);

  const results: ProjectMatch[] = Array.from(repoMap.entries())
    .map(([repo, data]) => {
      const skillEvidencePaths = evidencePathsRanked(data.evidencePathScore);
      const skillTechHints = Array.from(data.techHints).slice(0, 12);
      return {
        repo,
        techStack: Array.from(data.techStack),
        score: data.score,
        samplePaths: skillEvidencePaths,
        ...(skillTechHints.length ? { skillTechHints } : {}),
        ...(skillEvidencePaths.length ? { skillEvidencePaths } : {}),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  setCache(searchCache, cacheKey, results, 30_000);
  return results;
}
