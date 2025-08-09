// src/answer.ts
import { OpenAI } from "openai";
import { hybridSearch } from "./search.js";

type Cfg = { workdir: string; openaiApiKey: string; pine: { index: any } };

export type AnswerResult = {
  text: string;                 // final answer (cited)
  used: { path: string; start: number; end: number }[]; // snippets referenced
};

export async function answerAboutProject(
  { workdir, openaiApiKey, pine, repo, question }: Cfg & { repo: string; question: string }
): Promise<AnswerResult> {
  // Retrieve context
  const ctx = await hybridSearch({ workdir, openaiApiKey, pine, repo, query: question });

  // Build compact, cited context (cap 12 chunks)
  const top = (ctx || []).slice(0, 12);
  const used = top.map((c: any) => ({ path: c.path, start: c.start, end: c.end }));
  const context = top.map((c: any, i: number) =>
    `(${i + 1}) ${c.path}#L${c.start}-L${c.end}\n${c.text}`
  ).join("\n\n");

  const sys =
    "You are a senior engineer. Answer ONLY from the provided context. " +
    "Cite each claim with path#Lstart-Lend. If evidence is insufficient, say \"unknown\". " +
    "Be concise and technical.";

  const user =
    `Question: ${question}\n\n` +
    `Context:\n${context}\n\n` +
    "Answer with sections: Purpose, Architecture, Key modules, How to run, Notable details. Include citations.";

  const openai = new OpenAI({ apiKey: openaiApiKey });
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ],
    max_tokens: 2000,
  });

  const text = res.choices[0]?.message?.content?.trim() ?? "unknown";
  return { text, used };
}