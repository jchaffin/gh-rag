```ts
import { createGhRag } from "@jchaffin/gh-rag";

const rag = await createGhRag({
  openaiApiKey: process.env.OPENAI_API_KEY!,
  pinecone: { apiKey: process.env.PINECONE_API_KEY!, index: "repo-chunks" },
});

await rag.ingest({ gitUrl: "https://github.com/owner/repo.git" });

const { text } = await rag.answer({
  repo: "repo",
  question: "Tell me about the payments project"
});
console.log(text);
```

## Realtime ask (low-latency retrieval)

For voice or streaming clients, pull context snippets fast without generating a full answer:

```ts
const rag = createGhRag({
  openaiApiKey: process.env.OPENAI_API_KEY!,
  pine: { index: /* Pinecone index handle */ } as any,
});

const snippets = await rag.ask({ repo: "repo", query: "auth flow", limit: 6 });
// Each snippet: { path, start, end, text }
```

Server endpoint (Fastify):
- Start: `npm run build && npm run start`
- POST http://localhost:3000/ask with JSON `{ "repo": "repo", "query": "auth flow", "limit": 6 }`

Notes:
- Set `OPENAI_EMBED_MODEL` to match your ingested index (e.g., `text-embedding-3-small` for speed). Ingestion also respects this.
- In-memory caching smooths identical queries for ~10s; embeddings cache for ~60s.

## CLI

Ask questions from the command line after ingesting a repo into Pinecone.

- Env: set `OPENAI_API_KEY`, `PINECONE_API_KEY`, optional `PINECONE_INDEX` (default `repo-chunks`), optional `GITHUB_TOKEN`.

Examples:

```
# Build once
npm run build

# Ask (uses env REPO and QUESTION if set)
npm run ask -- --repo my-repo --question "What does the auth flow look like?"

# With JSON output
npm run ask -- -r my-repo -q "Key modules?" --json

# If installed globally (after publish or npm link)
gh-rag-ask -r my-repo "How do I run this?"

# Ingest a repo (GitHub URL or local path)
npm run ask -- --repo-url https://github.com/owner/repo.git --repo repo

# Ingest then immediately ask in one command
npm run ask -- --repo-url https://github.com/owner/repo.git -q "What are the core services?"

# Ingest ALL your GitHub repos (requires GITHUB_TOKEN)
# Default filters: excludes forks and archived repos
npm run ingest:all -- --affiliation owner --visibility all --concurrency 2

# Or if installed globally
gh-rag-ingest-all --affiliation owner --visibility all

# Flags:
#   --include-forks        Include forked repos
#   --include-archived     Include archived repos
#   --dry-run              List what would be ingested
#   --index <name>         Override Pinecone index
```
