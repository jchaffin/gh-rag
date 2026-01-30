#!/usr/bin/env node
// scripts/ingest-org.ts - Ingest repos from a GitHub organization
import { config } from "dotenv";
import { resolve } from "path";
import { Pinecone } from "@pinecone-database/pinecone";
import pLimit from "p-limit";
import { ingestRepo } from "@/ingest";

config({ path: resolve(process.cwd(), ".env.local"), override: true });

type CliOpts = {
  org?: string;
  index?: string;
  includeForks?: boolean;
  includeArchived?: boolean;
  type?: string; // all|public|private|forks|sources|member
  concurrency?: number;
  dryRun?: boolean;
  debug?: boolean;
  help?: boolean;
};

function usage() {
  const u = `
gh-rag ingest-org - Ingest all repos from a GitHub organization

Usage:
  gh-rag-ingest-org --org <name> [options]

Options:
  --org <name>             GitHub organization name (required)
  --index <name>           Pinecone index (default env PINECONE_INDEX or repo-chunks)
  --type <type>            Repo type: all|public|private|forks|sources|member (default: all)
  --include-forks          Include forked repos (default: false)
  --include-archived       Include archived repos (default: false)
  --concurrency <n>        Concurrent ingests (default: 2)
  --dry-run                List targets without ingesting
  --debug                  Verbose logging
  -h, --help               Show help

Environment:
  OPENAI_API_KEY, PINECONE_API_KEY, [PINECONE_INDEX], GITHUB_TOKEN
`;
  console.log(u.trimStart());
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { opts.help = true; continue; }
    if (a === "--debug") { opts.debug = true; continue; }
    if (a === "--dry-run") { opts.dryRun = true; continue; }
    if (a === "--include-forks") { opts.includeForks = true; continue; }
    if (a === "--include-archived") { opts.includeArchived = true; continue; }
    if (a === "--org") { opts.org = argv[++i]; continue; }
    if (a === "--index") { opts.index = argv[++i]; continue; }
    if (a === "--type") { opts.type = argv[++i]; continue; }
    if (a === "--concurrency") { opts.concurrency = Number(argv[++i] ?? 2); continue; }
  }
  return opts;
}

type GhRepo = {
  full_name: string; // owner/name
  fork: boolean;
  archived: boolean;
  private: boolean;
  size: number;
};

async function listOrgRepos(params: {
  token: string;
  org: string;
  type?: string;
  debug?: boolean;
}): Promise<GhRepo[]> {
  const { token, org, type = "all", debug } = params;
  const perPage = 100;
  let page = 1;
  const all: GhRepo[] = [];
  for (;;) {
    const url = new URL(`https://api.github.com/orgs/${org}/repos`);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set("type", type);
    const res = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API ${res.status}: ${body}`);
    }
    const batch = (await res.json()) as GhRepo[];
    if (debug) console.error(`Fetched page ${page} (${batch.length})`);
    all.push(...batch);
    if (batch.length < perPage) break;
    page++;
    // small delay to be nice to API
    await new Promise(r => setTimeout(r, 100));
  }
  return all;
}

function mask(v?: string) {
  return v ? v.slice(0, 6) + "…" + v.slice(-4) : "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (args.debug) process.env.DEBUG = "1";

  if (!args.org) {
    console.error("Error: --org <name> is required");
    return usage();
  }

  const {
    OPENAI_API_KEY,
    PINECONE_API_KEY,
    PINECONE_INDEX,
    GITHUB_TOKEN,
  } = process.env;

  const indexName = args.index || PINECONE_INDEX || "repo-chunks";
  if (!OPENAI_API_KEY || !PINECONE_API_KEY || !indexName || !GITHUB_TOKEN) {
    console.error("Missing env. Need OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX (or --index), and GITHUB_TOKEN");
    process.exit(1);
  }

  if (process.env.DEBUG) {
    console.error("OPENAI_API_KEY:", mask(OPENAI_API_KEY));
    console.error("PINECONE_API_KEY:", mask(PINECONE_API_KEY));
    console.error("PINECONE_INDEX:", indexName);
  }

  console.log(`Listing repos for organization: ${args.org}…`);
  const repos = await listOrgRepos({
    token: GITHUB_TOKEN,
    org: args.org,
    type: args.type || "all",
    debug: args.debug,
  });

  const filtered = repos.filter(r =>
    (args.includeForks || !r.fork) &&
    (args.includeArchived || !r.archived)
  );
  if (repos.length && !filtered.length) {
    console.warn("No repos after filters. You may want --include-forks or --include-archived");
  }

  console.log(`Found ${repos.length} repos, ${filtered.length} after filters`);
  if (args.dryRun) {
    for (const r of filtered) console.log("-", r.full_name, r.private ? "(private)" : "(public)");
    return;
  }

  const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
  const index = pc.index(indexName);

  const limit = pLimit(Math.max(1, Math.min(args.concurrency ?? 2, 5)));
  let ok = 0, fail = 0;
  const tasks = filtered.map(repo => limit(async () => {
    const gitUrl = `https://github.com/${repo.full_name}.git`;
    console.log(`Ingesting ${repo.full_name}…`);
    try {
      const res = await ingestRepo(gitUrl, { openaiApiKey: OPENAI_API_KEY, pine: { index } });
      if (process.env.DEBUG) console.log("  →", res);
      ok++;
    } catch (e) {
      fail++;
      console.error(`Failed ${repo.full_name}:`, (e as Error).message || e);
    }
  }));

  await Promise.allSettled(tasks);
  console.log(`Done. Success: ${ok}, Failed: ${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
