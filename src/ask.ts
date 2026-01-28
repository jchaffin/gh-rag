import { hybridSearch } from "./search";
import type { Cfg, AskSnippet } from "./types";

export type { AskSnippet };

export async function askFast(
  params: Cfg & { repo: string; query: string; limit?: number; includeText?: boolean }
): Promise<AskSnippet[]> {
  const { workdir, openaiApiKey, pine, repo, query, limit = 8, includeText = true } = params;
  const ctx = await hybridSearch({ workdir, openaiApiKey, pine, repo, query });
  const top = (ctx || []).slice(0, limit);
  return top.map((c: any) => ({
    path: c.path,
    start: c.start,
    end: c.end,
    ...(includeText ? { text: c.text } : {}),
  }));
}

