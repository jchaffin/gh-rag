#!/usr/bin/env node
// src/cli.ts - Unified CLI for gh-rag
import { config } from "dotenv";
import { resolve } from "path";
import { execSync } from "child_process";
import { Pinecone } from "@pinecone-database/pinecone";
import pLimit from "p-limit";
import { createGhRag } from "./index";
import { ingestRepo } from "./ingest";

// Load env before anything else, but get gh token first if needed
let ghCliToken: string | undefined;
if (process.argv.includes("--use-gh-token")) {
  try {
    ghCliToken = execSync("gh auth token", { encoding: "utf8" }).trim();
  } catch {
    console.error("Failed to get token from gh CLI. Ensure gh is installed and authenticated.");
    process.exit(1);
  }
}

config({ path: resolve(process.cwd(), ".env.local"), override: true });

if (ghCliToken) {
  process.env.GITHUB_TOKEN = ghCliToken;
}

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

function mask(v?: string) {
  return v ? v.slice(0, 6) + "…" + v.slice(-4) : "";
}

function getEnv() {
  const {
    OPENAI_API_KEY,
    PINECONE_API_KEY,
    PINECONE_INDEX = "repo-chunks",
    GITHUB_TOKEN,
  } = process.env;
  return { OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX, GITHUB_TOKEN };
}

function requireEnv(...keys: string[]) {
  const env = getEnv();
  const missing = keys.filter(k => !(env as any)[k]);
  if (missing.length) {
    console.error(`Missing env: ${missing.join(", ")}`);
    process.exit(1);
  }
  return env;
}

function getPinecone(apiKey: string, indexName: string) {
  const pc = new Pinecone({ apiKey });
  return pc.index(indexName);
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

async function cmdFind(args: string[]) {
  const opts: Record<string, any> = {};
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") { opts.help = true; continue; }
    if (a === "--json") { opts.json = true; continue; }
    if (a === "--debug") { opts.debug = true; continue; }
    if (a === "-s" || a === "--skill") { opts.skill = args[++i]; continue; }
    if (a === "-l" || a === "--limit") { opts.limit = Number(args[++i]); continue; }
    if (a === "--index") { opts.index = args[++i]; continue; }
    if (!a.startsWith("-")) rest.push(a);
  }

  if (!opts.skill && rest.length) opts.skill = rest.join(" ");

  if (opts.help) {
    console.log(`
gh-rag find - Find projects by skill/technology

Usage:
  gh-rag find --skill <name>
  gh-rag find "TypeScript"
  gh-rag find -s "Next.js"

Options:
  -s, --skill <name>       Skill/technology to search for
  -l, --limit <n>          Max results (default: 20)
      --index <name>       Pinecone index name
      --json               Output JSON
      --debug              Debug logging
  -h, --help               Show help
`);
    return;
  }

  if (opts.debug) process.env.DEBUG = "1";

  const env = requireEnv("OPENAI_API_KEY", "PINECONE_API_KEY");
  const indexName = opts.index || env.PINECONE_INDEX;

  if (!opts.skill) {
    console.error("Missing --skill or skill name");
    process.exit(1);
  }

  const index = getPinecone(env.PINECONE_API_KEY!, indexName);
  const rag = createGhRag({
    openaiApiKey: env.OPENAI_API_KEY!,
    githubToken: env.GITHUB_TOKEN,
    pine: { index },
  });

  const results = await rag.findBySkill({ skill: opts.skill, limit: opts.limit });

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    if (results.length === 0) {
      console.log(`\nNo projects found with skill: "${opts.skill}"`);
      return;
    }
    console.log(`\nProjects with "${opts.skill}" (${results.length} found):\n`);
    for (const r of results) {
      console.log(`  ${r.repo}`);
      console.log(`    Tech: ${r.techStack.slice(0, 5).join(", ")}${r.techStack.length > 5 ? "..." : ""}`);
      console.log(`    Score: ${r.score.toFixed(3)}`);
      console.log();
    }
  }
}

async function cmdAsk(args: string[]) {
  const opts: Record<string, any> = {};
  const rest: string[] = [];
  
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") { opts.help = true; continue; }
    if (a === "--json") { opts.json = true; continue; }
    if (a === "--debug") { opts.debug = true; continue; }
    if (a === "-r" || a === "--repo") { opts.repo = args[++i]; continue; }
    if (a === "-q" || a === "--question") { opts.question = args[++i]; continue; }
    if (a === "--index") { opts.index = args[++i]; continue; }
    if (!a.startsWith("-")) rest.push(a);
  }
  
  if (!opts.question && rest.length) opts.question = rest.join(" ");
  
  if (opts.help) {
    console.log(`
gh-rag ask - Ask questions about a repo

Usage:
  gh-rag ask --repo <name> --question <text>
  gh-rag ask -r <name> "What does X do?"

Options:
  -r, --repo <name>        Repo identifier
  -q, --question <text>    Question to ask
      --index <name>       Pinecone index name
      --json               Output JSON
      --debug              Debug logging
  -h, --help               Show help
`);
    return;
  }

  if (opts.debug) process.env.DEBUG = "1";
  
  const env = requireEnv("OPENAI_API_KEY", "PINECONE_API_KEY");
  const indexName = opts.index || env.PINECONE_INDEX;
  
  if (!opts.repo || !opts.question) {
    console.error("Missing --repo and --question");
    process.exit(1);
  }

  const index = getPinecone(env.PINECONE_API_KEY!, indexName);
  const rag = createGhRag({
    openaiApiKey: env.OPENAI_API_KEY!,
    githubToken: env.GITHUB_TOKEN,
    pine: { index },
  });

  const res = await rag.answer({ repo: opts.repo, question: opts.question });

  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log("\n" + res.text);
    if (res.used?.length) {
      console.log("\nCitations:");
      for (const u of res.used) console.log(`  ${u.path}#L${u.start}-L${u.end}`);
    }
  }
}

async function cmdIngest(args: string[]) {
  const opts: Record<string, any> = { repos: [] };
  
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") { opts.help = true; continue; }
    if (a === "--debug") { opts.debug = true; continue; }
    if (a === "--dry-run") { opts.dryRun = true; continue; }
    if (a === "--index") { opts.index = args[++i]; continue; }
    if (a === "--use-gh-token") continue; // already handled
    if (a.startsWith("https://") || (a.includes("/") && !a.startsWith("-"))) {
      opts.repos.push(a);
    }
  }

  if (opts.help) {
    console.log(`
gh-rag ingest - Ingest GitHub repos

Usage:
  gh-rag ingest <repo-url> [repo-url...]
  gh-rag ingest https://github.com/org/repo

Options:
      --index <name>       Pinecone index name
      --use-gh-token       Use gh CLI token
      --dry-run            List without ingesting
      --debug              Debug logging
  -h, --help               Show help
`);
    return;
  }

  if (opts.debug) process.env.DEBUG = "1";
  
  const env = requireEnv("OPENAI_API_KEY", "PINECONE_API_KEY", "GITHUB_TOKEN");
  const indexName = opts.index || env.PINECONE_INDEX;

  if (!opts.repos.length) {
    console.error("No repos specified. Usage: gh-rag ingest <repo-url>");
    process.exit(1);
  }

  const repos = opts.repos.map((r: string) => {
    if (!r.startsWith("https://")) return `https://github.com/${r}.git`;
    return r.endsWith(".git") ? r : `${r}.git`;
  });

  console.log(`Repos to ingest (${repos.length}):`);
  for (const r of repos) console.log("  -", r);

  if (opts.dryRun) return;

  const index = getPinecone(env.PINECONE_API_KEY!, indexName);

  for (const gitUrl of repos) {
    console.log(`Ingesting ${gitUrl}…`);
    try {
      const res = await ingestRepo(gitUrl, {
        openaiApiKey: env.OPENAI_API_KEY!,
        pine: { index },
      });
      console.log(`  ✓ ${res.repo}: ${res.files} files, ${res.chunks} chunks`);
    } catch (e) {
      console.error(`  ✗ Failed:`, (e as Error).message);
    }
  }
}

async function cmdIngestAll(args: string[]) {
  const opts: Record<string, any> = {};
  
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") { opts.help = true; continue; }
    if (a === "--debug") { opts.debug = true; continue; }
    if (a === "--dry-run") { opts.dryRun = true; continue; }
    if (a === "--include-forks") { opts.includeForks = true; continue; }
    if (a === "--include-archived") { opts.includeArchived = true; continue; }
    if (a === "--index") { opts.index = args[++i]; continue; }
    if (a === "--org") { opts.org = args[++i]; continue; }
    if (a === "--affiliation") { opts.affiliation = args[++i]; continue; }
    if (a === "--visibility") { opts.visibility = args[++i]; continue; }
    if (a === "--concurrency") { opts.concurrency = Number(args[++i] ?? 2); continue; }
  }

  if (opts.help) {
    console.log(`
gh-rag ingest-all - Ingest all repos from user or org

Usage:
  gh-rag ingest-all [options]
  gh-rag ingest-all --org <name>

Options:
      --org <name>         GitHub organization (default: your repos)
      --index <name>       Pinecone index name
      --affiliation <type> owner,collaborator,organization_member
      --visibility <type>  all|public|private
      --include-forks      Include forked repos
      --include-archived   Include archived repos
      --concurrency <n>    Concurrent ingests (default: 2)
      --dry-run            List without ingesting
      --debug              Debug logging
  -h, --help               Show help
`);
    return;
  }

  if (opts.debug) process.env.DEBUG = "1";
  
  const env = requireEnv("OPENAI_API_KEY", "PINECONE_API_KEY", "GITHUB_TOKEN");
  const indexName = opts.index || env.PINECONE_INDEX;

  // Fetch repos
  type GhRepo = { full_name: string; fork: boolean; archived: boolean; private: boolean };
  const repos: GhRepo[] = [];
  const perPage = 100;
  let page = 1;

  const baseUrl = opts.org
    ? `https://api.github.com/orgs/${opts.org}/repos`
    : "https://api.github.com/user/repos";

  console.log(opts.org ? `Listing repos for org: ${opts.org}…` : "Listing your repos…");

  for (;;) {
    const url = new URL(baseUrl);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    if (!opts.org) {
      url.searchParams.set("affiliation", opts.affiliation || "owner");
      url.searchParams.set("visibility", opts.visibility || "all");
    }

    const res = await fetch(url, {
      headers: {
        Authorization: `token ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`GitHub API ${res.status}: ${body}`);
      process.exit(1);
    }

    const batch = (await res.json()) as GhRepo[];
    repos.push(...batch);
    if (batch.length < perPage) break;
    page++;
    await new Promise(r => setTimeout(r, 100));
  }

  const filtered = repos.filter(r =>
    (opts.includeForks || !r.fork) &&
    (opts.includeArchived || !r.archived)
  );

  console.log(`Found ${repos.length} repos, ${filtered.length} after filters`);

  if (opts.dryRun) {
    for (const r of filtered) console.log("-", r.full_name, r.private ? "(private)" : "(public)");
    return;
  }

  const index = getPinecone(env.PINECONE_API_KEY!, indexName);
  const limit = pLimit(Math.max(1, Math.min(opts.concurrency ?? 2, 5)));
  let ok = 0, fail = 0;

  const tasks = filtered.map(repo => limit(async () => {
    const gitUrl = `https://github.com/${repo.full_name}.git`;
    console.log(`Ingesting ${repo.full_name}…`);
    try {
      await ingestRepo(gitUrl, { openaiApiKey: env.OPENAI_API_KEY!, pine: { index } });
      ok++;
    } catch (e) {
      fail++;
      console.error(`  Failed: ${(e as Error).message}`);
    }
  }));

  await Promise.allSettled(tasks);
  console.log(`Done. Success: ${ok}, Failed: ${fail}`);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
gh-rag - RAG over GitHub repos

Usage:
  gh-rag <command> [options]

Commands:
  find         Find projects by skill/technology
  ask          Ask questions about an ingested repo
  ingest       Ingest specific GitHub repos
  ingest-all   Ingest all repos from user or org

Run 'gh-rag <command> --help' for command-specific options.

Environment:
  OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX, GITHUB_TOKEN
`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === "-h" || cmd === "--help") {
    showHelp();
    return;
  }

  switch (cmd) {
    case "find":
      await cmdFind(args);
      break;
    case "ask":
      await cmdAsk(args);
      break;
    case "ingest":
      await cmdIngest(args);
      break;
    case "ingest-all":
      await cmdIngestAll(args);
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
