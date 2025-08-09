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