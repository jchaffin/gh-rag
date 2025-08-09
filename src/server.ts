import Fastify from "fastify";
import { Pinecone } from "@pinecone-database/pinecone";
import { ingestRepo } from "@/ingest";
import { answerAboutProject } from "@/answer";

const app = Fastify({ logger: true });

// Env checks
const {
  OPENAI_API_KEY,
  PINECONE_API_KEY,
  PINECONE_INDEX,
} = process.env;
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");
if (!PINECONE_API_KEY) throw new Error("PINECONE_API_KEY required");
if (!PINECONE_INDEX) throw new Error("PINECONE_INDEX required");

// Pinecone
const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
const index = pc.index(PINECONE_INDEX);

// Optional: verify index dim
// const info = await pc.describeIndex(PINECONE_INDEX);
// app.log.info({ dim: info.dimension }, "pinecone index");

// Routes
app.post("/ingest", async (req: any, rep: any) => {
  const { gitUrl } = (req.body as any) || {};
  if (!gitUrl) return rep.code(400).send({ error: "gitUrl required" });
  const res = await ingestRepo(gitUrl, { openaiApiKey: OPENAI_API_KEY, pine: { index } });
  return rep.send(res);
});

app.post("/answer", async (req: any, rep: any) => {
  const { repo, question } = (req.body as any) || {};
  if (!repo || !question) return rep.code(400).send({ error: "repo and question required" });
  const text = await answerAboutProject({
    repo,
    question,
    workdir: ".",
    openaiApiKey: OPENAI_API_KEY,
    pine: { index },
  });
  return rep.send({ text });
});

// Start
app.listen({ port: 3000, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});