#!/usr/bin/env node
// scripts/ingest-repos.ts - Ingest specific repos by URL
import { config } from "dotenv";
import { resolve } from "path";
import { Pinecone } from "@pinecone-database/pinecone";
import pLimit from "p-limit";
import { ingestRepo } from "@/ingest";
import { execSync } from "child_process";

// Get gh CLI token BEFORE dotenv loads (gh CLI respects GITHUB_TOKEN env var)
let ghCliToken: string | undefined;
if (process.argv.includes("--use-gh-token")) {
  try {
    ghCliToken = execSync("gh auth token", { encoding: "utf8" }).trim();
    console.log(`Got gh CLI token (prefix: ${ghCliToken.slice(0, 6)})`);
  } catch (e) {
    console.error("Failed to get token from gh CLI. Ensure gh is installed and authenticated.");
    process.exit(1);
  }
}

config({ path: resolve(process.cwd(), ".env.local"), override: true });

// Override GITHUB_TOKEN with gh CLI token if requested
if (ghCliToken) {
  process.env.GITHUB_TOKEN = ghCliToken;
}

type CliOpts = {
  repos: string[];
  index?: string;
  concurrency?: number;
  dryRun?: boolean;
  debug?: boolean;
  useGhToken?: boolean;
  help?: boolean;
};

function usage() {
  const u = `
gh-rag ingest-repos - Ingest specific GitHub repos

Usage:
  gh-rag-ingest-repos <repo-url> [repo-url...] [options]

Options:
  --index <name>           Pinecone index (default env PINECONE_INDEX or repo-chunks)
  --concurrency <n>        Concurrent ingests (default: 2)
  --use-gh-token           Use token from gh CLI instead of GITHUB_TOKEN env var
  --dry-run                List targets without ingesting
  --debug                  Verbose logging
  -h, --help               Show help

Environment:
  OPENAI_API_KEY, PINECONE_API_KEY, [PINECONE_INDEX], GITHUB_TOKEN

Examples:
  gh-rag-ingest-repos https://github.com/org/repo1.git https://github.com/org/repo2.git
  gh-rag-ingest-repos https://github.com/ProsodyAI/prosodyai.git --use-gh-token
`;
  console.log(u.trimStart());
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { repos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { opts.help = true; continue; }
    if (a === "--debug") { opts.debug = true; continue; }
    if (a === "--dry-run") { opts.dryRun = true; continue; }
    if (a === "--use-gh-token") { opts.useGhToken = true; continue; }
    if (a === "--index") { opts.index = argv[++i]; continue; }
    if (a === "--concurrency") { opts.concurrency = Number(argv[++i] ?? 2); continue; }
    if (a.startsWith("https://") || a.includes("/")) {
      opts.repos.push(a);
    }
  }
  return opts;
}

function mask(v?: string) {
  return v ? v.slice(0, 6) + "…" + v.slice(-4) : "";
}


async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (args.debug) process.env.DEBUG = "1";

  if (args.repos.length === 0) {
    console.error("Error: At least one repo URL is required");
    return usage();
  }

  const {
    OPENAI_API_KEY,
    PINECONE_API_KEY,
    PINECONE_INDEX,
  } = process.env;

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  const indexName = args.index || PINECONE_INDEX || "repo-chunks";
  if (!OPENAI_API_KEY || !PINECONE_API_KEY || !indexName || !GITHUB_TOKEN) {
    console.error("Missing env. Need OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX (or --index), and GITHUB_TOKEN (or --use-gh-token)");
    process.exit(1);
  }

  if (process.env.DEBUG) {
    console.error("OPENAI_API_KEY:", mask(OPENAI_API_KEY));
    console.error("PINECONE_API_KEY:", mask(PINECONE_API_KEY));
    console.error("PINECONE_INDEX:", indexName);
    console.error("GITHUB_TOKEN:", mask(GITHUB_TOKEN));
  }

  // Normalize repo URLs
  const repos = args.repos.map(r => {
    if (!r.startsWith("https://")) {
      return `https://github.com/${r}.git`;
    }
    return r.endsWith(".git") ? r : `${r}.git`;
  });

  console.log(`Repos to ingest (${repos.length}):`);
  for (const r of repos) console.log("  -", r);

  if (args.dryRun) {
    console.log("\n(dry run - no ingestion performed)");
    return;
  }

  const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
  const index = pc.index(indexName);

  const limit = pLimit(Math.max(1, Math.min(args.concurrency ?? 2, 5)));
  let ok = 0, fail = 0;
  const tasks = repos.map(gitUrl => limit(async () => {
    console.log(`Ingesting ${gitUrl}…`);
    try {
      const res = await ingestRepo(gitUrl, { openaiApiKey: OPENAI_API_KEY, pine: { index } });
      console.log(`  ✓ ${res.repo}: ${res.files} files, ${res.chunks} chunks`);
      ok++;
    } catch (e) {
      fail++;
      console.error(`  ✗ Failed ${gitUrl}:`, (e as Error).message || e);
    }
  }));

  await Promise.allSettled(tasks);
  console.log(`\nDone. Success: ${ok}, Failed: ${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
