// src/ingest.ts
import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import { encode, decode } from "gpt-tokenizer";
import type { Pinecone } from "@pinecone-database/pinecone";

const MODEL = process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-large";
const MODEL_DIMS: Record<string, number> = {
  "text-embedding-3-large": 3072,
  "text-embedding-3-small": 1536,
};
const MAX_TOKENS = 8192;
const CHUNK_TOKENS = 4000; // Reduced from 6000 to stay well under 8192 limit
const BATCH_SIZE = 64;

export type PineCtx = {
  index: ReturnType<Pinecone["index"]>;
  namespace?: string;
};

type IngestOpts = {
  openaiApiKey: string;
  pine: PineCtx;
  workdir?: string; // default "."
  repoName?: string; // optional override
  githubToken?: string; // for GitHub API access
};

export async function ingestRepo(gitUrlOrPath: string, opts: IngestOpts) {
  const workdir = opts.workdir ?? ".";
  
  // Handle GitHub URLs by fetching via API
  if (gitUrlOrPath.startsWith('https://github.com/')) {
    // Extract owner/repo from GitHub URL
    const match = gitUrlOrPath.match(/github\.com\/([^\/]+\/[^\/]+?)(?:\.git)?$/);
    if (!match) throw new Error('Invalid GitHub URL');
    
    const [owner, repo] = match[1].split('/');
    const namespace = repo; // Use just the repo name, not owner/repo
    
    if (process.env.DEBUG) console.log(`Fetching ${owner}/${repo} via GitHub API`);
    
    // Fetch all files recursively from GitHub API
    const allFiles = await fetchAllFilesFromGitHub(owner, repo);
    const docs = allFiles.map(f => ({ path: f.path, text: f.content }));
    
    const records = chunkDocs(repo, docs);
    
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
    const index = opts.pine.index;
    if (process.env.DEBUG) console.log("Upserting", records.length, "records to Pinecone");
    
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const sliceRecs = records.slice(i, i + BATCH_SIZE);
      const sliceVecs = vectors.slice(i, i + BATCH_SIZE);
      if (process.env.DEBUG) console.log(`Upserting batch ${i/BATCH_SIZE + 1}:`, sliceRecs.length, "records");
      
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
            text: r.text,
          }),
        }))
      );
    }
    if (process.env.DEBUG) console.log("Pinecone upsert complete");
    
    return { repo, namespace, files: docs.length, chunks: records.length, model: MODEL };
  } else {
    // Local path handling
    const repo = opts.repoName ?? repoIdFromPathOrUrl(gitUrlOrPath);
    const namespace = opts.pine.namespace ?? repo;

    const files = await listRepoFiles(gitUrlOrPath);
    const docs = await readFiles(gitUrlOrPath, files);

    const records = chunkDocs(repo, docs);

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
    const index = opts.pine.index;
    if (process.env.DEBUG) console.log("Upserting", records.length, "records to Pinecone");
    
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const sliceRecs = records.slice(i, i + BATCH_SIZE);
      const sliceVecs = vectors.slice(i, i + BATCH_SIZE);
      if (process.env.DEBUG) console.log(`Upserting batch ${i/BATCH_SIZE + 1}:`, sliceRecs.length, "records");
      
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
            text: r.text,
          }),
        })),
      );
    }
    if (process.env.DEBUG) console.log("Pinecone upsert complete");

    return { repo, namespace, files: files.length, chunks: records.length, model: MODEL };
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
    "!**/.git/**",
    "!**/dist/**",
    "!**/build/**",
    "!**/.next/**",
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

async function fetchAllFilesFromGitHub(owner: string, repo: string): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];
  const processedPaths = new Set<string>();
  
  async function fetchDirectory(path: string = '') {
    if (processedPaths.has(path)) return;
    processedPaths.add(path);
    
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    if (process.env.DEBUG) console.log(`Fetching: ${apiUrl}`);
    
    const response = await fetch(apiUrl, {
      headers: {
        ...(process.env.GITHUB_TOKEN && { Authorization: `token ${process.env.GITHUB_TOKEN}` }),
        ...(process.env.GITHUB_USERNAME && { 'User-Agent': process.env.GITHUB_USERNAME })
      }
    });
    
    if (!response.ok) {
      if (process.env.DEBUG) console.log(`Skipping ${path}: ${response.status}`);
      return;
    }
    
    const contents = (await response.json()) as GhContentItem[];
    
    for (const item of contents) {
      if (item.type === 'file' && isProbablyTextPath(item.name)) {
        try {
          const fileResponse = await fetch(String(item.download_url));
          const content = await fileResponse.text();
          files.push({ path: item.path, content });
          if (process.env.DEBUG) console.log(`Fetched: ${item.path}`);
        } catch (e) {
          if (process.env.DEBUG) console.log(`Failed to fetch ${item.path}:`, e);
        }
      } else if (item.type === 'dir') {
        await fetchDirectory(item.path);
      }
    }
    
    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
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

async function embedInBatches(apiKey: string, inputs: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch = inputs.slice(i, i + BATCH_SIZE);
    // sanity: ensure none exceed limit
    for (const s of batch) {
      const t = encode(s).length;
      if (t > MAX_TOKENS) throw new Error(`Chunk exceeds ${MAX_TOKENS} tokens: ${t}`);
    }
    const vecs = await embedBatch(apiKey, batch);
    out.push(...vecs);
  }
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
