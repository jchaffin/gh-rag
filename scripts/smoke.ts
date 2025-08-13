// scripts/smoke.ts
import { config } from "dotenv";
import { resolve } from "path";
import { Pinecone } from "@pinecone-database/pinecone";
import { simpleGit } from "simple-git";
import path from "path";

config({ path: resolve(process.cwd(), ".env.local"), override: true });

import { createGhRag } from "@lib";
import { ingestRepo } from "@lib/ingest";

function mask(v?: string) {
  return v ? v.slice(0, 6) + "…" + v.slice(-4) : "";
}

console.log("OPENAI_API_KEY:", mask(process.env.OPENAI_API_KEY));
console.log("PINECONE_API_KEY:", mask(process.env.PINECONE_API_KEY));

async function main() {
  const {
    OPENAI_API_KEY,
    PINECONE_API_KEY,
    PINECONE_INDEX = "repo-chunks",
    GITHUB_TOKEN,
    TEST_REPO = "https://github.com/jchaffin/JobLaunch.git"
  } = process.env;

  if (!OPENAI_API_KEY || !PINECONE_API_KEY || !PINECONE_INDEX) {
    console.error("Missing env. Need OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX");
    process.exit(1);
  }

  // Create Pinecone instance
  const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
  const index = pc.index(PINECONE_INDEX);

  const rag = createGhRag({
    openaiApiKey: OPENAI_API_KEY,
    githubToken: GITHUB_TOKEN, // optional
    pine: {
      index: index, // Pass the actual index instance, not the string
    },
  });

  console.time("ingest");
  const ingestRes = await ingestRepo(TEST_REPO, {
    openaiApiKey: OPENAI_API_KEY,
    pine: { index: index }
  });
  console.timeEnd("ingest");
  console.log("Ingested:", ingestRes);

  console.time("answer");
  const res = await rag.answer({
    repo: ingestRes.repo,
    question: "Tell me about the API Integrations",
  });
  console.timeEnd("answer");

  console.log("\n=== ANSWER ===\n");
  console.log(res.text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
