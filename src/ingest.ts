// src/ingest.ts
import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import ignore from "ignore";
import pLimit from "p-limit";
import { encode, decode } from "gpt-tokenizer";
import type { PineCtx, IngestOpts } from "./types";

export type { PineCtx, IngestOpts };

const MODEL = process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-large";
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";
const MODEL_DIMS: Record<string, number> = {
  "text-embedding-3-large": 3072,
  "text-embedding-3-small": 1536,
};
const MAX_TOKENS = 8192;
const CHUNK_TOKENS = 4000; // Reduced from 6000 to stay well under 8192 limit
const BATCH_SIZE = 64;

/** Path segments we never ingest (deps, caches, build trees) — applied even if .gitignore is missing. */
const ALWAYS_IGNORE_DIR_SEGMENTS = new Set([
  "node_modules",
  "jspm_packages",
  "bower_components",
  "__pycache__",
  ".pytest_cache",
  ".tox",
  ".venv",
  "venv",
  ".mypy_cache",
  ".ruff_cache",
  ".pnpm-store",
  "Pods",
  "Carthage",
  ".gradle",
  "coverage",
  ".nyc_output",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".parcel-cache",
]);

function pathTouchesIgnoredSegment(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return norm.split("/").some((seg) => ALWAYS_IGNORE_DIR_SEGMENTS.has(seg));
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// Use LLM to detect tech stack from repo files
async function detectTechStack(apiKey: string, files: { path: string; text: string }[]): Promise<string[]> {
  if (files.length === 0) return [];

  // Build context: file tree + sample of file contents
  const fileTree = files.map(f => f.path).join('\n');
  
  // Sample some files (prioritize root-level and config-looking files, but don't hardcode)
  const sorted = [...files].sort((a, b) => {
    const aDepth = a.path.split('/').length;
    const bDepth = b.path.split('/').length;
    return aDepth - bDepth; // Root files first
  });
  
  const sampled = sorted.slice(0, 15);
  const fileContents = sampled.map(f => {
    const content = f.text.length > 1500 ? f.text.slice(0, 1500) + '...' : f.text;
    return `--- ${f.path} ---\n${content}`;
  }).join('\n\n');

  const context = `FILE TREE:\n${fileTree.slice(0, 3000)}\n\nSAMPLE FILES:\n${fileContents}`.slice(0, 12000);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: "You analyze codebases and identify the tech stack. Return ONLY a JSON array of strings with technologies, frameworks, languages, and tools used. Be specific (e.g., 'Next.js 14' not just 'React'). Include versions when apparent. Max 15 items, most important first."
        },
        {
          role: "user", 
          content: `Analyze this codebase and return the tech stack as a JSON array:\n\n${context}`
        }
      ],
      max_tokens: 300,
      temperature: 0,
    }),
  });

  if (!res.ok) {
    if (process.env.DEBUG) console.log("Tech stack detection failed:", await res.text());
    return [];
  }

  const json = await res.json() as { choices: { message: { content: string } }[] };
  const content = json.choices[0]?.message?.content?.trim() ?? "[]";
  
  try {
    // Extract JSON array from response (handle markdown code blocks)
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch {
    if (process.env.DEBUG) console.log("Failed to parse tech stack:", content);
  }
  
  return [];
}

export async function ingestRepo(gitUrlOrPath: string, opts: IngestOpts) {
  const workdir = opts.workdir ?? ".";
  
  // Handle GitHub URLs by fetching via API
  if (gitUrlOrPath.startsWith('https://github.com/')) {
    // Extract owner/repo from GitHub URL
    const match = gitUrlOrPath.match(/github\.com\/([^\/]+\/[^\/]+?)(?:\.git)?$/);
    if (!match) throw new Error('Invalid GitHub URL');
    
    const [owner, repo] = match[1].split('/');
    // Full `owner/repo` avoids Pinecone namespace collisions (e.g. ProsodyAI/api vs other orgs).
    const repoId = `${owner}/${repo}`;
    const namespace = opts.pine.namespace ?? repoId;

    if (process.env.DEBUG) console.log(`Fetching ${repoId} via GitHub API`);
    
    // Fetch all files recursively from GitHub API
    const allFiles = await fetchAllFilesFromGitHub(owner, repo, opts.githubToken);
    const docs = allFiles.map(f => ({ path: f.path, text: f.content }));
    
    // Detect tech stack using LLM
    if (process.env.DEBUG) console.log("Detecting tech stack...");
    const techStack = await detectTechStack(opts.openaiApiKey, docs);
    if (process.env.DEBUG) console.log("Tech stack:", techStack);
    
    const records = chunkDocs(repoId, docs);

    // Optionally write BM25 index for MiniSearch consumption
    if (opts.writeBm25 || process.env.GH_RAG_WRITE_BM25 === '1') {
      await writeBm25Index(repoId, records, workdir);
    }
    
    const vectors = await embedInBatches(
      opts.openaiApiKey,
      records.map((r) => r.text),
    );
    
    const dim = MODEL_DIMS[MODEL];
    if (!dim) throw new Error(`Unknown dims for model ${MODEL}`);
    if (vectors.some((v) => v.length !== dim)) {
      throw new Error(`Embedding dim mismatch. Expected ${dim}`);
    }
    
    // Upsert to Pinecone
    const index = namespace ? opts.pine.index.namespace(namespace) : opts.pine.index;
    if (process.env.DEBUG) console.log("Using namespace:", namespace || "<default>");
    if (process.env.DEBUG) console.log("Upserting", records.length, "records to Pinecone");
    await upsertChunkBatches(index, records, vectors, techStack);
    if (process.env.DEBUG) console.log("Pinecone upsert complete");
    
    return { repo: repoId, namespace, files: docs.length, chunks: records.length, model: MODEL, techStack };
  } else {
    // Local path handling
    const repo = opts.repoName ?? repoIdFromPathOrUrl(gitUrlOrPath);
    const namespace = opts.pine.namespace ?? repo;

    const files = await listRepoFiles(gitUrlOrPath);
    const docs = await readFiles(gitUrlOrPath, files);

    // Detect tech stack using LLM
    if (process.env.DEBUG) console.log("Detecting tech stack...");
    const techStack = await detectTechStack(opts.openaiApiKey, docs);
    if (process.env.DEBUG) console.log("Tech stack:", techStack);

    const records = chunkDocs(repo, docs);

    // Optionally write BM25 index for MiniSearch consumption
    if (opts.writeBm25 || process.env.GH_RAG_WRITE_BM25 === '1') {
      await writeBm25Index(repo, records, workdir);
    }

    const vectors = await embedInBatches(
      opts.openaiApiKey,
      records.map((r) => r.text),
    );

    const dim = MODEL_DIMS[MODEL];
    if (!dim) throw new Error(`Unknown dims for model ${MODEL}`);
    if (vectors.some((v) => v.length !== dim)) {
      throw new Error(`Embedding dim mismatch. Expected ${dim}`);
    }

    // Upsert to Pinecone
    const index = namespace ? opts.pine.index.namespace(namespace) : opts.pine.index;
    if (process.env.DEBUG) console.log("Using namespace:", namespace || "<default>");
    if (process.env.DEBUG) console.log("Upserting", records.length, "records to Pinecone");
    await upsertChunkBatches(index, records, vectors, techStack);
    if (process.env.DEBUG) console.log("Pinecone upsert complete");

    return { repo, namespace, files: files.length, chunks: records.length, model: MODEL, techStack };
  }
}

// ---------- helpers ----------

function repoIdFromPathOrUrl(input: string) {
  // supports: owner/name(.git)? or local folder
  const base = input.replace(/\/+$/, "");
  const name = base.split("/").pop() ?? "repo";
  return name.replace(/\.git$/i, "").toLowerCase();
}

async function listRepoFiles(root: string) {
  const patterns = [
    "**/*",
    "!**/node_modules/**",
    "!**/jspm_packages/**",
    "!**/bower_components/**",
    "!**/__pycache__/**",
    "!**/.pytest_cache/**",
    "!**/.tox/**",
    "!**/.venv/**",
    "!**/venv/**",
    "!**/.mypy_cache/**",
    "!**/.ruff_cache/**",
    "!**/.pnpm-store/**",
    "!**/Pods/**",
    "!**/Carthage/**",
    "!**/.gradle/**",
    "!**/coverage/**",
    "!**/.nyc_output/**",
    "!**/.next/**",
    "!**/.nuxt/**",
    "!**/.output/**",
    "!**/.turbo/**",
    "!**/.parcel-cache/**",
    "!**/.git/**",
    "!**/dist/**",
    "!**/build/**",
    "!**/*.png",
    "!**/*.jpg",
    "!**/*.jpeg",
    "!**/*.gif",
    "!**/*.pdf",
    "!**/*.ico",
    "!**/*.lock",
    "!**/*.min.*",
    "!**/*.svg",
    "!**/*.webp",
    "!**/*.mp3",
    "!**/*.mp4",
    "!**/*.wav",
    "!**/*.ogg",
    "!**/*.zip",
    "!**/*.tar",
    "!**/*.gz",
  ];
  const files = await glob(patterns, { cwd: root, nodir: true, dot: false });
  // Keep text-like files
  return files.filter(isProbablyTextPath);
}

function isProbablyTextPath(p: string) {
  const ext = path.extname(p).toLowerCase();
  if (!ext) return true;
  const textExts = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".java", ".go", ".rb", ".rs", ".php",
    ".cs", ".cpp", ".c", ".h", ".hpp",
    ".json", ".yml", ".yaml", ".toml", ".ini",
    ".md", ".txt",
    ".html", ".css", ".scss", ".less",
    ".sh", ".bash", ".zsh", ".env",
    ".sql",
  ]);
  return textExts.has(ext);
}

async function readFiles(root: string, files: string[]) {
  const out: { path: string; text: string }[] = [];
  for (const rel of files) {
    if (pathTouchesIgnoredSegment(rel)) continue;
    const abs = path.join(root, rel);
    try {
      const buf = await fs.readFile(abs);
      // assume UTF-8; if needed detect encoding
      const text = buf.toString("utf8");
      if (text.trim().length === 0) continue;
      out.push({ path: rel, text });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

/** Correct gitignore semantics (negations, order) — micromatch was matching nearly every path. */
function buildIgnoreMatcherFromRaw(raw: string): (filePath: string) => boolean {
  const trimmed = raw.trim();
  if (!trimmed) return () => false;
  const ig = ignore().add(trimmed);
  return (filePath: string) => ig.ignores(filePath);
}

async function fetchGitignoreRaw(
  owner: string,
  repo: string,
  ghHeaders: Record<string, string>,
): Promise<string> {
  try {
    // Use the raw-content accept header so installation tokens work on private repos.
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/.gitignore`,
      { headers: { ...ghHeaders, Accept: "application/vnd.github.raw" } },
    );
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  }
}

function buildGhHeaders(token?: string): Record<string, string> {
  // GitHub App installation tokens (`ghs_…`) and user-to-server tokens (`gho_…`)
  // both work with the `Bearer` scheme. Classic PATs accept `token` as a prefix.
  const useBearer = token?.startsWith("ghs_") || token?.startsWith("gho_");
  const authHeader = token ? (useBearer ? `Bearer ${token}` : `token ${token}`) : undefined;
  return {
    ...(authHeader && { Authorization: authHeader }),
    'User-Agent': process.env.GITHUB_USERNAME || 'gh-rag',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function fetchAllFilesFromGitHub(
  owner: string,
  repo: string,
  ghToken?: string,
): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];
  const processedPaths = new Set<string>();

  const effectiveToken = ghToken ?? process.env.GITHUB_TOKEN;
  const ghHeaders = buildGhHeaders(effectiveToken);

  const gitignoreRaw = await fetchGitignoreRaw(owner, repo, ghHeaders);
  if (process.env.DEBUG) {
    const lines = gitignoreRaw.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
    console.log(`Loaded .gitignore (${lines.length} rule lines)`);
  }
  const isIgnored = buildIgnoreMatcherFromRaw(gitignoreRaw);

  async function fetchDirectory(dirPath: string = '') {
    if (processedPaths.has(dirPath)) return;
    processedPaths.add(dirPath);

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}`;
    if (process.env.DEBUG) console.log(`Fetching: ${apiUrl}`);

    const response = await fetch(apiUrl, { headers: ghHeaders });

    if (!response.ok) {
      if (process.env.DEBUG) console.log(`Skipping ${dirPath}: ${response.status}`);
      return;
    }

    const contents = (await response.json()) as GhContentItem[];

    const fileItems: GhContentItem[] = [];
    const dirItems: GhContentItem[] = [];
    for (const item of contents) {
      if (pathTouchesIgnoredSegment(item.path)) {
        if (process.env.DEBUG) console.log(`Hard-ignored (deps/cache): ${item.path}`);
        continue;
      }
      if (isIgnored(item.path)) {
        if (process.env.DEBUG) console.log(`Ignored: ${item.path}`);
        continue;
      }
      if (item.type === "file" && isProbablyTextPath(item.name)) fileItems.push(item);
      else if (item.type === "dir") dirItems.push(item);
    }

    const fileDlLimit = pLimit(24);
    const rawHeaders = { ...ghHeaders, Accept: "application/vnd.github.raw" };
    const fileRows = await Promise.all(
      fileItems.map((item) =>
        fileDlLimit(async () => {
          // Use the raw content API so the same Authorization header works for
          // private repos accessed via GitHub App installation tokens.
          const rawUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(item.path)}`;
          try {
            const fileResponse = await fetch(rawUrl, { headers: rawHeaders });
            if (!fileResponse.ok) {
              if (process.env.DEBUG) console.log(`Skipping ${item.path}: ${fileResponse.status}`);
              return null;
            }
            const content = await fileResponse.text();
            if (process.env.DEBUG) console.log(`Fetched: ${item.path}`);
            return { path: item.path, content };
          } catch (e) {
            if (process.env.DEBUG) console.log(`Failed to fetch ${item.path}:`, e);
            return null;
          }
        }),
      ),
    );
    for (const row of fileRows) {
      if (row) files.push(row);
    }

    const subdirLimit = pLimit(10);
    await Promise.all(dirItems.map((item) => subdirLimit(() => fetchDirectory(item.path))));

    const dirCooldownMs = Number(
      process.env.GH_RAG_GITHUB_DIR_MS ?? (effectiveToken ? 40 : 100),
    );
    if (Number.isFinite(dirCooldownMs) && dirCooldownMs > 0) {
      await new Promise((r) => setTimeout(r, dirCooldownMs));
    }
  }

  await fetchDirectory();
  return files;
}

type RecordChunk = {
  id: string;
  repo: string;
  path: string;
  start: number; // token start
  end: number;   // token end (exclusive)
  tokens: number;
  text: string;
};

// GitHub /contents API item (directory listing)
type GhContentItem = {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  download_url?: string | null;
};

function chunkDocs(repo: string, docs: { path: string; text: string }[]): RecordChunk[] {
  const chunks: RecordChunk[] = [];
  for (const d of docs) {
    const ids = encode(d.text);
    for (let i = 0; i < ids.length; i += CHUNK_TOKENS) {
      const slice = ids.slice(i, i + CHUNK_TOKENS);
      const text = decode(slice);
      const id = `${repo}:${d.path}:${i}-${i + slice.length}`;
      chunks.push({
        id,
        repo,
        path: d.path,
        start: i,
        end: i + slice.length,
        tokens: slice.length,
        text,
      });
    }
  }
  return chunks;
}

// Persist a newline-delimited JSON file with { id, text } for BM25 search.
// The search loader expects this at: path.join(workdir, repo, ".bm25.jsonl").
async function upsertChunkBatches(
  index: { upsert: (data: any[]) => Promise<void> },
  records: RecordChunk[],
  vectors: number[][],
  techStack: string[],
) {
  const parallel = clampInt(Number(process.env.GH_RAG_PINECONE_PARALLEL ?? 4), 1, 8);
  const limit = pLimit(parallel);
  const starts: number[] = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) starts.push(i);
  await Promise.all(
    starts.map((i) =>
      limit(async () => {
        const sliceRecs = records.slice(i, i + BATCH_SIZE);
        const sliceVecs = vectors.slice(i, i + BATCH_SIZE);
        if (process.env.DEBUG) {
          console.log(`Upserting batch ${i / BATCH_SIZE + 1}:`, sliceRecs.length, "records");
        }
        await index.upsert(
          sliceRecs.map((r, j) => ({
            id: r.id,
            values: sliceVecs[j],
            metadata: fitMetadata({
              repo: r.repo,
              path: r.path,
              start: r.start,
              end: r.end,
              tokens: r.tokens,
              model: MODEL,
              techStack,
              text: r.text,
            }),
          })),
        );
      }),
    ),
  );
}

async function writeBm25Index(repo: string, records: RecordChunk[], workdir: string) {
  try {
    const repoDir = path.join(workdir, repo);
    await fs.mkdir(repoDir, { recursive: true });
    const file = path.join(repoDir, ".bm25.jsonl");
    const lines = records.map(r => JSON.stringify({ id: r.id, text: r.text }));
    await fs.writeFile(file, lines.join("\n"), "utf8");
    if (process.env.DEBUG) console.log(`Wrote BM25 index: ${file} (${lines.length} docs)`);
  } catch (e) {
    console.warn("Failed to write BM25 index:", (e as Error)?.message || e);
  }
}

async function embedInBatches(apiKey: string, inputs: string[]): Promise<number[][]> {
  type Batch = { start: number; inputs: string[] };
  const batches: Batch[] = [];
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const slice = inputs.slice(i, i + BATCH_SIZE);
    for (const s of slice) {
      const t = encode(s).length;
      if (t > MAX_TOKENS) throw new Error(`Chunk exceeds ${MAX_TOKENS} tokens: ${t}`);
    }
    batches.push({ start: i, inputs: slice });
  }
  const parallel = clampInt(Number(process.env.GH_RAG_EMBED_PARALLEL ?? 4), 1, 8);
  const limit = pLimit(parallel);
  const parts = await Promise.all(
    batches.map((b) =>
      limit(async () => {
        const vecs = await embedBatch(apiKey, b.inputs);
        return { start: b.start, vecs };
      }),
    ),
  );
  parts.sort((a, b) => a.start - b.start);
  const out: number[][] = [];
  for (const p of parts) out.push(...p.vecs);
  return out;
}

async function embedBatch(apiKey: string, inputs: string[]): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(process.env.OPENAI_ORG && { "OpenAI-Organization": process.env.OPENAI_ORG }),
      ...(process.env.OPENAI_PROJECT && { "OpenAI-Project": process.env.OPENAI_PROJECT }),
    },
    body: JSON.stringify({ input: inputs, model: MODEL }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding API ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

// Ensure Pinecone metadata stays under 40KB per vector.
// Trims the `text` field if necessary and sets a `truncated` flag.
function fitMetadata<T extends { text?: string }>(meta: T, maxBytes = 40960): T & { truncated?: boolean } {
  const encodeSize = (m: any) => Buffer.byteLength(JSON.stringify(m), "utf8");
  let cur: any = { ...meta };
  let size = encodeSize(cur);
  if (size <= maxBytes) return cur;

  if (typeof cur.text !== "string" || cur.text.length === 0) {
    // Nothing we can trim; return as-is (will likely still error, but no better option)
    return cur;
  }

  // Binary search the maximum text length that fits under maxBytes
  const original = cur.text;
  let lo = 0;
  let hi = original.length;
  let best: { obj: any; size: number } | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidateText = original.slice(0, mid) + "…";
    const candidate = { ...cur, text: candidateText, truncated: true };
    const s = encodeSize(candidate);
    if (s <= maxBytes) {
      best = { obj: candidate, size: s };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return (best?.obj ?? { ...cur, text: "", truncated: true }) as T & { truncated?: boolean };
}
