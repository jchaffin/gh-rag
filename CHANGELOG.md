# Changelog

## 0.4.1

- **`find` / `findBySkill`:** Only returns repos where the skill appears in **indexed chunk text** (token-style match) or in **ingest-time tech-stack** labels. No semantic-only fallback; empty results mean no explicit hit.
- CLI shows **Stack match** and **In text** (paths) when present.
- Skill search scans up to **400** Pinecone namespaces (was 64) and uses slightly higher per-namespace `topK` to surface literal mentions.

## 0.4.0

### Breaking

- **GitHub ingest namespace and repo id** are now `owner/repo` (for example `ProsodyAI/prosodyai`), not the bare repository name (`prosodyai`). This avoids Pinecone namespace collisions when the same slug exists under different owners.
- **`gh-rag ask` / `rag.answer` / `rag.ask`:** pass `repo` as `owner/repo` for GitHub-ingested repositories. Local-path ingests are unchanged and still use the folder-derived slug (or `repoName` override).

### Migration

- Re-ingest GitHub repositories you care about so vectors live under the new namespaces. Old short-name namespaces can be removed from Pinecone when you no longer need them.
