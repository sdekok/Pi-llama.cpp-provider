import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { LlamaClient, parseModelArgs } from "./llama-client";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Find all providers in models.json that declared api:"llamacpp".
 * Returns a map of providerName -> baseUrl.
 *
 * We read models.json directly rather than scanning the model registry because
 * a provider entry with no "models" array produces no registry entries — the
 * registry only tracks individual models, not provider-level config.
 */
export function findConfiguredServers(): Map<string, string> {
  const servers = new Map<string, string>();
  const modelsPath = path.join(getAgentDir(), "models.json");

  if (!fs.existsSync(modelsPath)) return servers;

  try {
    const config = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    if (config.providers && typeof config.providers === "object") {
      for (const [name, provider] of Object.entries(config.providers as Record<string, any>)) {
        if (provider.api === "llamacpp" && provider.baseUrl) {
          servers.set(name, provider.baseUrl);
        }
      }
    }
  } catch (e) {}

  return servers;
}

/**
 * Resolve the server URL when no models.json config exists.
 * Precedence: env var → project settings → global settings → default.
 */
export async function getFallbackBaseUrl(ctx: ExtensionContext): Promise<string> {
  if (process.env.LLAMA_CPP_BASE_URL) return process.env.LLAMA_CPP_BASE_URL;

  const projectSettingsPath = path.join(ctx.cwd, ".pi", "settings.json");
  if (fs.existsSync(projectSettingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(projectSettingsPath, "utf8"));
      if (settings.llama?.baseUrl) return settings.llama.baseUrl;
    } catch (e) {}
  }

  const globalSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  if (fs.existsSync(globalSettingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(globalSettingsPath, "utf8"));
      if (settings.llama?.baseUrl) return settings.llama.baseUrl;
    } catch (e) {}
  }

  return "http://localhost:8080";
}

export async function registerLlamaProvider(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  providerName: string,
  baseUrl: string
): Promise<void> {
  const client = new LlamaClient(baseUrl);

  const status = await client.getStatus();
  if (!status.ok) {
    console.error(`[${providerName}] Server not found at ${baseUrl}: ${status.message}`);
    return;
  }

  const [models, metadata] = await Promise.all([
    client.getModels(),
    client.getActiveModelMetadata(),
  ]);

  const dynamicModels = models.map((m) => {
    const parsed = parseModelArgs(m);
    // Prefer per-model ctx from status.args (works on router setups where /props
    // returns n_ctx:0). Fall back to /props metadata for single-instance servers.
    const ctx = parsed.contextWindow ?? metadata?.contextWindow ?? 4096;
    // Explicit --reasoning on/off in args wins; fall back to name heuristic.
    const reasoning = parsed.reasoning ?? /coder|r1|deepseek|think|reason/i.test(m.id);
    return {
      id: m.id,
      name: m.id,
      contextWindow: ctx,
      maxTokens: ctx,
      reasoning,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });

  // Check for duplicate OpenAI provider at the same base URL
  const openaiDupes = ctx.modelRegistry
    .getAll()
    .filter((m: any) => m.provider === "openai" && m.baseUrl === baseUrl);

  pi.registerProvider(providerName, {
    baseUrl,
    api: "openai-responses", // llama.cpp implements OpenAI-compatible endpoints
    apiKey: "none",          // local/remote models without auth
    models: dynamicModels,
  });

  let msg = `[${providerName}] Registered ${dynamicModels.length} model(s)`;
  if (metadata?.contextWindow) msg += ` (context: ${metadata.contextWindow})`;
  if (openaiDupes.length > 0)
    msg += `\n⚠️  Duplicate: ${openaiDupes.length} OpenAI model(s) also configured for ${baseUrl}`;

  ctx.ui.notify(msg, openaiDupes.length > 0 ? "warning" : "info");
}

export default async function (pi: ExtensionAPI) {
  pi.on("resources_discover", async (event, ctx) => {
    try {
      const configured = findConfiguredServers();

      if (configured.size > 0) {
        // Register each server declared in models.json with api:"llamacpp"
        await Promise.all(
          Array.from(configured.entries()).map(([name, url]) =>
            registerLlamaProvider(pi, ctx, name, url)
          )
        );
      } else {
        // Fall back to single auto-discovered server
        const baseUrl = await getFallbackBaseUrl(ctx);
        await registerLlamaProvider(pi, ctx, "llama-cpp", baseUrl);
      }
    } catch (error: any) {
      console.error(`[llama-cpp] Failed to register provider: ${error.message}`);
    }

    return {};
  });

}
