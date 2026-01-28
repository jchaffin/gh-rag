// src/index.ts
import { ingestRepo } from "./ingest";
import { hybridSearch } from "./search";
import { answerAboutProject } from "./answer";
import { askFast } from "./ask";
import type { CreateOpts } from "./types";

export type { CreateOpts };
export * from "./types";

export function createGhRag(opts: CreateOpts & { pine: { index: any } }) {
  const cfg = {
    openaiApiKey: opts.openaiApiKey,
    githubToken: opts.githubToken,
    workdir: ".",
    pine: opts.pine
  };

  return {
    ingest: (p: { gitUrl: string; ref?: string; fileGlobs?: string[] }) =>
      ingestRepo(p.gitUrl, {
        openaiApiKey: cfg.openaiApiKey,
        pine: cfg.pine
      }),
    search: (p: { repo: string; query: string }) =>
      hybridSearch({ ...cfg, repo: p.repo, query: p.query }),
    ask: (p: { repo: string; query: string; limit?: number; includeText?: boolean }) =>
      askFast({ ...cfg, repo: p.repo, query: p.query, limit: p.limit, includeText: p.includeText }),
    answer: (p: { repo: string; question: string }) =>
      answerAboutProject({ ...cfg, repo: p.repo, question: p.question })
  };
}
