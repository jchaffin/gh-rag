import MiniSearch from "minisearch";
import fs from "fs/promises";
import path from "path";
import { OpenAI } from "openai";

type Cfg = { workdir: string; openaiApiKey: string; pine: { index: any } };

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
  const openai = new OpenAI({ apiKey: openaiApiKey });
  const r = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: query
  });
  return r.data[0].embedding;
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
  console.log("Search path:", repoPath);
  
  const mini = await loadMini(repoPath);
  console.log("Mini search loaded:", !!mini);

  // BM25
  const bm = mini
    ? mini
        .search(query, { prefix: true })
        .slice(0, 40)
        .map(r => ({ id: r.id, score: r.score }))
    : [];
  console.log("BM25 results:", bm.length);

  // Pinecone KNN
  console.log("Searching for repo:", repo);
  const vec = await embedQuery(openaiApiKey, query);
  console.log("Vector length:", vec.length);
  
  const pineResults = await pine.index.query({
    vector: vec,
    topK: 40,
    includeMetadata: true
  });
  console.log("Pinecone results:", pineResults);
  console.log("Pinecone matches:", pineResults.matches?.length || 0);
  
  const knn = (pineResults.matches || []).map((m: any) => ({
    id: m.id as string,
    score: m.score || 0
  }));
  console.log("KNN results:", knn.length);

  // Fuse
  const fused = rrf(bm, knn).slice(0, 20);

  // Map IDs back to metadata
  const metaById = Object.fromEntries(
    (pineResults.matches || []).map((m: any) => [m.id as string, m.metadata])
  );

  return fused.map(f => metaById[f.id]).filter(Boolean);
}