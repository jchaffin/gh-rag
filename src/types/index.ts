// src/types/index.ts
// Centralized type definitions

import type { Pinecone } from "@pinecone-database/pinecone";

// ─────────────────────────────────────────────────────────────
// Core types
// ─────────────────────────────────────────────────────────────

export type Chunk = {
  repo: string;
  path: string;
  start: number;
  end: number;
  text: string;
  fileType: string;
  commit: string;
};

// ─────────────────────────────────────────────────────────────
// Pinecone types
// ─────────────────────────────────────────────────────────────

export type PineCtx = {
  index: ReturnType<Pinecone["index"]>;
  namespace?: string;
};

export type PCVector = {
  id: string;
  values: number[];
  metadata?: Record<string, any>;
};

// ─────────────────────────────────────────────────────────────
// Config types
// ─────────────────────────────────────────────────────────────

export type Cfg = {
  workdir: string;
  openaiApiKey: string;
  pine: { index: any };
};

export type CreateOpts = {
  openaiApiKey: string;
  githubToken?: string; // optional, for private repos or higher API limits
};

export type IngestOpts = {
  openaiApiKey: string;
  pine: PineCtx;
  workdir?: string; // default "."
  repoName?: string; // optional override
  githubToken?: string; // for GitHub API access
  // If true, write a local BM25 jsonl alongside vectors.
  // Default: false (opt-in only) to avoid creating local folders during ingest.
  writeBm25?: boolean;
};

// ─────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────

export type AskSnippet = {
  path: string;
  start: number;
  end: number;
  text?: string;
};

export type AnswerResult = {
  text: string; // final answer (cited)
  used: { path: string; start: number; end: number }[]; // snippets referenced
};
