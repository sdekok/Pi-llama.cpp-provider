import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { LlamaClient, parseModelArgs } from "./llama-client";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Startup cache — avoids the race condition where pi resolves defaultModel
// before the async network calls in resources_discover complete.
// ---------------------------------------------------------------------------

interface DynamicModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface CacheEntry {
  baseUrl: string;
  models: DynamicModel[];
  savedAt: number;
}

type ProviderCache = Record<string, CacheEntry>; // keyed by providerName

function getCacheFile(): string {
  return path.join(getAgentDir(), "llama-cpp-cache.json");
}

function loadCache(): ProviderCache {
  try {
    const file = getCacheFile();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (e) {}
  return {};
}

function saveCache(cache: ProviderCache): void {
  try {
    fs.writeFileSync(getCacheFile(), JSON.stringify(cache, null, 2));
  } catch (e) {}
}

// ---------------------------------------------------------------------------

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
  const cache = loadCache();

  // Fetch live data — parallelize all three calls to minimize latency.
  const [status, models, metadata] = await Promise.all([
    client.getStatus(),
    client.getModels().catch(() => null),
    client.getActiveModelMetadata().catch(() => null),
  ]);

  if (!status.ok) {
    console.error(`[${providerName}] Server not found at ${baseUrl}: ${status.message}`);
    const cachedEntry = cache[providerName];
    if (cachedEntry && cachedEntry.models.length > 0) {
      ctx.ui.notify(`[${providerName}] Server offline — using ${cachedEntry.models.length} cached model(s)`, "warning");
    }
    return;
  }

  if (!models) {
    console.error(`[${providerName}] Failed to fetch models from ${baseUrl}`);
    return;
  }

  const dynamicModels: DynamicModel[] = models.map((m) => {
    const parsed = parseModelArgs(m);
    const ctxSize = parsed.contextWindow ?? metadata?.contextWindow ?? 4096;
    const reasoning = parsed.reasoning ?? /coder|r1|deepseek|think|reason/i.test(m.id);
    return {
      id: m.id,
      name: m.id,
      contextWindow: ctxSize,
      maxTokens: ctxSize,
      reasoning,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });

  // Persist for next startup
  cache[providerName] = { baseUrl, models: dynamicModels, savedAt: Date.now() };
  saveCache(cache);

  // Check for duplicate OpenAI provider at the same base URL
  const openaiDupes = ctx.modelRegistry
    .getAll()
    .filter((m: any) => m.provider === "openai" && m.baseUrl === baseUrl);

  // Re-register with live data (overwrites the cache-based registration)
  pi.registerProvider(providerName, {
    baseUrl,
    api: "openai-responses",
    apiKey: "none",
    models: dynamicModels,
  });

  let msg = `[${providerName}] Registered ${dynamicModels.length} model(s)`;
  if (metadata?.contextWindow) msg += ` (context: ${metadata.contextWindow})`;
  if (openaiDupes.length > 0)
    msg += `\n⚠️  Duplicate: ${openaiDupes.length} OpenAI model(s) also configured for ${baseUrl}`;

  ctx.ui.notify(msg, openaiDupes.length > 0 ? "warning" : "info");
}

/**
 * Pre-register cached providers during extension setup — before resources_discover fires
 * and before pi resolves defaultModel. Without this, pi can't find the llama-cpp provider
 * at startup and falls back to another configured provider (e.g. openrouter).
 *
 * For the fallback (no models.json config), we resolve the URL without ctx.cwd since
 * project-level settings aren't available yet; env var and global settings still work.
 */
function preRegisterFromCache(pi: ExtensionAPI): void {
  const cache = loadCache();
  const configured = findConfiguredServers();

  if (configured.size > 0) {
    for (const [name, url] of configured.entries()) {
      const cached = cache[name];
      if (cached && cached.baseUrl === url && cached.models.length > 0) {
        pi.registerProvider(name, {
          baseUrl: url,
          api: "openai-responses",
          apiKey: "none",
          models: cached.models,
        });
      }
    }
  } else {
    // Resolve URL without ctx: env var → global settings → default
    let fallbackUrl = process.env.LLAMA_CPP_BASE_URL;
    if (!fallbackUrl) {
      const globalSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
      if (fs.existsSync(globalSettingsPath)) {
        try {
          const s = JSON.parse(fs.readFileSync(globalSettingsPath, "utf8"));
          if (s.llama?.baseUrl) fallbackUrl = s.llama.baseUrl;
        } catch {}
      }
    }
    if (!fallbackUrl) fallbackUrl = "http://localhost:8080";

    const cached = cache["llama-cpp"];
    if (cached && cached.baseUrl === fallbackUrl && cached.models.length > 0) {
      pi.registerProvider("llama-cpp", {
        baseUrl: fallbackUrl,
        api: "openai-responses",
        apiKey: "none",
        models: cached.models,
      });
    }
  }
}

export default async function (pi: ExtensionAPI) {
  // Register from cache immediately so pi can resolve defaultModel before
  // resources_discover fires and live network calls complete.
  preRegisterFromCache(pi);

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
