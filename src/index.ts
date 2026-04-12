import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { LlamaClient, ModelMetadata } from "./llama-client";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

async function getBaseUrl(ctx: any): Promise<string> {
  if (process.env.LLAMA_CPP_BASE_URL) return process.env.LLAMA_CPP_BASE_URL;

  const projectSettingsPath = path.join(ctx.cwd, ".pi", "settings.json");
  if (fs.existsSync(projectSettingsPath)) {
    try {
      const content = fs.readFileSync(projectSettingsPath, "utf8");
      const settings = JSON.parse(content);
      if (settings.llama?.baseUrl) return settings.llama.baseUrl;
    } catch (e) {}
  }

  const globalSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  if (fs.existsSync(globalSettingsPath)) {
    try {
      const content = fs.readFileSync(globalSettingsPath, "utf8");
      const settings = JSON.parse(content);
      if (settings.llama?.baseUrl) return settings.llama.baseUrl;
    } catch (e) {}
  }

  return "http://localhost:8080"; 
}

export default async function (pi: ExtensionAPI) {
  // We use the resources_discover event to inject our provider before pi finishes startup
  pi.on("resources_discover", async (event, ctx) => {
    const baseUrl = await getBaseUrl(ctx);
    const client = new LlamaClient(baseUrl);

    try {
      // 1. Check if server is alive
      const status = await client.getStatus();
      if (!status.ok) {
        console.error(`[llama-cpp] Server not found at ${baseUrl}: ${status.message}`);
        return {}; 
      }

      // 2. Fetch models and metadata
      const [models, metadata] = await Promise.all([
        client.getModels(),
        client.getActiveModelMetadata()
      ]);

      // 2.5. Check for duplicate OpenAI provider configuration
      const existingModels = ctx.modelRegistry.getAll();
      const openaiModelsWithSameBase = existingModels.filter(
        (m: any) => m.provider === "openai" && m.baseUrl === baseUrl
      );

      if (openaiModelsWithSameBase.length > 0) {
        console.warn(
          `[llama-cpp] Found ${openaiModelsWithSameBase.length} OpenAI models already configured for ${baseUrl}. ` +
          `Registering llama-cpp provider anyway with auto-detected metadata.`
        );
      }

      // 3. Map to pi Provider format
      const dynamicModels: any[] = models.map(m => ({
        id: m.id,
        name: m.id,
        contextWindow: metadata?.contextWindow || 4096,
        parameterSize: metadata?.parameterSize,
        family: metadata?.family,
        reasoning: /coder|r1|deepseek|think|reason/i.test(m.id),
        input: ["text"], // Default fallback for pi's requirement
        cost: { input: 0, output: 0 }, // Free local models
        maxTokens: metadata?.contextWindow || 4096
      }));

      // 4. Register the provider dynamically
      pi.registerProvider("llama-cpp", {
        baseUrl: baseUrl,
        api: "openai-responses", // llama.cpp is OpenAI compatible
        models: dynamicModels
      });

      // Notify user with context window info and duplication warning if applicable
      let notificationMsg = `Registered ${dynamicModels.length} llama.cpp model(s)`;
      if (metadata?.contextWindow) {
        notificationMsg += ` (context: ${metadata.contextWindow})`;
      }

      if (openaiModelsWithSameBase.length > 0) {
        notificationMsg += `\n⚠️  Warning: ${openaiModelsWithSameBase.length} OpenAI model(s) also configured for ${baseUrl}`;
      }

      ctx.ui.notify(notificationMsg, openaiModelsWithSameBase.length > 0 ? "warning" : "info");

    } catch (error: any) {
      console.error(`[llama-cpp] Failed to register provider: ${error.message}`);
    }

    return {}; 
  });

  // Keep diagnostic commands for manual troubleshooting
  pi.registerCommand("llama-status", {
    description: "Check connection status to llama.cpp server",
    handler: async (_args, ctx) => {
      const baseUrl = await getBaseUrl(ctx);
      const client = new LlamaClient(baseUrl);
      const status = await client.getStatus();
      if (status.ok) {
        ctx.ui.notify("llama.cpp is connected!", "info");
      } else {
        ctx.ui.notify(`Connection failed: ${status.message}`, "error");
      }
    },
  });

  pi.registerCommand("llama-models", {
    description: "List models currently loaded in the llama.cpp server",
    handler: async (_args, ctx) => {
      try {
        const baseUrl = await getBaseUrl(ctx);
        const client = new LlamaClient(baseUrl);
        const models = await client.getModels();
        if (models.length === 0) {
          ctx.ui.notify("No models found in llama.cpp server.", "info");
          return;
        }

        let modelList = "📍 Active Models:\n";
        for (const m of models) {
          modelList += `  - ${m.id}\n`;
        }
        ctx.ui.notify(modelList, "info");
      } catch (error: any) {
        ctx.ui.notify(`Error fetching models: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("llama-info", {
    description: "Show llama.cpp server properties (parameters, context length)",
    handler: async (_args, ctx) => {
      try {
        const baseUrl = await getBaseUrl(ctx);
        const client = new LlamaClient(baseUrl);
        const props = await client.getProps();

        let infoStr = "📊 Llama.cpp Server Properties:\n";
        if (props && typeof props === 'object') {
          const keys = Object.keys(props);
          if (keys.length > 0) {
            infoStr += `  Found ${keys.length} properties.\n`;
            for (const key of keys) {
              if (key.toLowerCase().includes('ctx') || 
                  key.toLowerCase().includes('param') || 
                  key.toLowerCase().includes('model')) {
                infoStr += `  ${key}: ${JSON.stringify(props[key])}\n`;
              }
            }
          } else {
             infoStr += "  No properties found.\n";
          }
        }

        ctx.ui.notify(infoStr, "info");
      } catch (error: any) {
        ctx.ui.notify(`Error fetching info: ${error.message}`, "error");
      }
    },
  });
}
