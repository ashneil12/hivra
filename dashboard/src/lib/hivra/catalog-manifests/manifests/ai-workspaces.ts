// AI workspaces and automation apps with their own web builder.
import type { CatalogAppManifest } from "../schema";

export const AI_WORKSPACE_MANIFESTS: readonly CatalogAppManifest[] = [
  {
    id: "anythingllm",
    name: "AnythingLLM",
    vendor: "Mintplex Labs",
    category: "app",
    license: "MIT",
    sourceUrl: "https://github.com/Mintplex-Labs/anything-llm",
    tagline: "All-in-one MIT-licensed private RAG workspace, document chat and AI agent builder.",
    description: "Private document chat, RAG workspace, MCP tools and custom AI agents in one app.",
    capabilityLine: "AnythingLLM's web workspace with persistent document storage, terminal and files.",
    badge: "AI Workspace",
    accent: "#10b981",
    icon: "layers",
    jobs: ["assistant", "research", "self-hosted"],
    keywords: ["anythingllm", "rag", "documents", "pdf", "knowledge base", "chat", "mcp", "workspace", "mit"],
    talk: "In AnythingLLM's own web workspace.",
    firstTasks: [
      {
        title: "Build a document workspace",
        prompt: "Upload your PDFs or notes into a new workspace and ask AnythingLLM to cite sources in every answer.",
      },
      {
        title: "Enable an agent skill",
        prompt: "Open workspace agent settings, enable web browsing or MCP tools and run a research query.",
      },
    ],
    minPlan: "pro",
    weight: 2,
    floor: { cpu: 1, ram: 2 },
    recommended: { cpu: 2, ram: 4 },
    candidates: [{ cpu: 2, ram: 4 }, { cpu: 1, ram: 2 }],
    cpuOptions: [1, 2, 4, 8],
    ramOptions: [2, 4, 8, 16],
    managedVenice: true,
    llm: { wire: "openai", providers: ["venice"] },
    runtime: {
      kind: "docker-web",
      imageRepo: "mintplexlabs/anythingllm",
      imageTag: "latest",
      containerPort: 3001,
      hostPort: 3205,
      healthPath: "/api/ping",
      volumes: [{ name: "storage", mountPath: "/app/server/storage" }],
      env: {
        STORAGE_DIR: "/app/server/storage",
      },
      modelEnv: {
        apiKeyVar: "GENERIC_OPEN_AI_API_KEY",
        baseUrlVar: "GENERIC_OPEN_AI_BASE_PATH",
        modelVar: "GENERIC_OPEN_AI_MODEL_PREF",
        extraEnv: { LLM_PROVIDER: "generic-openai" },
      },
      proxyMode: "standard",
    },
    seo: {
      metaTitle: "AnythingLLM Cloud Hosting: Private RAG & AI Agent Workspace",
      metaDescription: "Deploy Mintplex Labs AnythingLLM on a dedicated cloud VM with persistent vector storage, document chat and MCP agents. From $9.99/mo.",
      summary: "Run the official MIT-licensed AnythingLLM Docker image on your own isolated cloud computer with persistent storage and Hivra sign-in.",
    },
  },
];
