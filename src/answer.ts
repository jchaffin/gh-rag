// src/answer.ts
import { OpenAI } from "openai";
import { hybridSearch } from "./search.js";
import type { Cfg, AnswerResult } from "./types";

export type { AnswerResult };

export async function answerAboutProject(
  { workdir, openaiApiKey, pine, repo, question }: Cfg & { repo: string; question: string }
): Promise<AnswerResult> {
  // Retrieve context
  const ctx = await hybridSearch({ workdir, openaiApiKey, pine, repo, query: question });

  // Build compact, cited context (cap 12 chunks)
  const top = (ctx || []).slice(0, 10);

  // Never call the LLM with no evidence — it will invent stack and APIs.
  if (!top.length) {
    const text =
      `No indexed snippets for Pinecone namespace "${repo}". ` +
      `Use -r / --repo exactly matching the ingest id: GitHub ingests use owner/repo (e.g. ProsodyAI/prosodyai). ` +
      `If the index was wiped, finish ingest for that repo first. ` +
      `Optional: GH_RAG_WRITE_BM25=1 during ingest plus a workdir containing ./${repo}/.bm25.jsonl enables local BM25 when vectors are missing.`;
    return { text, used: [] };
  }

  const used = top.map((c: any) => ({ path: c.path, start: c.start, end: c.end }));
  const context = top.map((c: any, i: number) => {
    const snippet = c.text.length > 1200 ? c.text.slice(0, 1200) + "\n…" : c.text;
    return `(${i + 1}) ${c.path}#L${c.start}-L${c.end}\n${snippet}`;
  }).join("\n\n");

  const sys =
    "You are a senior engineer. Answer ONLY from the provided context. " +
    "Always cite with (index) path#Lstart-Lend per claim. If evidence is insufficient, say 'unknown'. " +
    "Be concise, technical, and specific.";

  const user =
    `Question: ${question}\n\n` +
    `Context:\n${context}\n\n` +
    "Answer with sections: Purpose, Architecture, Key modules, How to run, Notable details. Include citations.";

  const openai = new OpenAI({ apiKey: openaiApiKey });
  const res = await openai.chat.completions.create({
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ],
    max_tokens: 2000,
  });

  const text = res.choices[0]?.message?.content?.trim() ?? "unknown";
  return { text, used };
}