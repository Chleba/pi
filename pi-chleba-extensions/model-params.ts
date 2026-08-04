import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(AGENT_DIR, "model-params.json");

interface ParamsConfig {
  default?: Record<string, unknown>;
  models?: Record<string, Record<string, unknown>>;
}

function loadConfig(): ParamsConfig {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config: ParamsConfig) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export default function (pi: ExtensionAPI) {
  // ——— Hook: inject params into provider request ———
  pi.on("before_provider_request", (event, ctx) => {
    const config = loadConfig();
    const modelId = ctx.model?.id ?? "";

    // Merge: defaults + model-specific overrides
    const params: Record<string, unknown> = { ...config.default };
    if (config.models?.[modelId]) {
      Object.assign(params, config.models[modelId]);
    }

    if (Object.keys(params).length === 0) return;

    // Determine provider API type from the payload shape
    const api = ctx.model?.api ?? "";

    if (api === "google-generative-ai") {
      // Google: params go inside generationConfig
      return {
        ...event.payload,
        generationConfig: {
          ...(event.payload as any)?.generationConfig,
          ...params,
        },
      };
    }

    // OpenAI / Anthropic: params go directly on the request body
    return {
      ...event.payload,
      ...params,
    };
  });

  // ——— Command: /params ———
  pi.registerCommand("params", {
    description: "View or set model generation parameters (temperature, top_p, etc.)",
    getArgumentCompletions: (prefix: string) => {
      const params = [
        "temperature",
        "top_p",
        "top_k",
        "presence_penalty",
        "frequency_penalty",
      ];
      const filtered = params
        .filter((p) => p.startsWith(prefix))
        .map((p) => ({ value: p, label: p }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx) => {
      const config = loadConfig();
      const modelId = ctx.model?.id ?? "(none)";
      const parts = args.trim().split(/\s+/).filter(Boolean);

      // No args: show current config
      if (parts.length === 0) {
        const modelParams = config.models?.[modelId] ?? {};
        const effective = { ...config.default, ...modelParams };

        let msg = `Model params for ${modelId}:\n`;
        if (Object.keys(effective).length === 0) {
          msg += "  (no params set — use /params <key> <value>)\n";
        } else {
          for (const [k, v] of Object.entries(effective)) {
            const source = config.default?.[k] !== undefined && modelParams[k] === undefined ? "default" : "model";
            msg += `  ${k}: ${v} (${source})\n`;
          }
        }
        msg += "\nConfig: " + CONFIG_FILE;
        ctx.ui.notify(msg.trim(), "info");
        return;
      }

      // /params reset — clear all params
      if (parts[0] === "reset") {
        saveConfig({});
        ctx.ui.notify("All model params cleared.", "info");
        return;
      }

      // /params reset <model> — clear model-specific params
      if (parts[0] === "reset" && parts[1]) {
        const cfg = loadConfig();
        delete cfg.models?.[parts[1]];
        saveConfig(cfg);
        ctx.ui.notify(`Model-specific params for ${parts[1]} cleared.`, "info");
        return;
      }

      // /params <key> <value> — set global default
      if (parts.length === 2) {
        const [key, value] = parts;
        const parsed = parseParamValue(value);
        config.default = { ...config.default, [key]: parsed };
        saveConfig(config);
        ctx.ui.notify(`Set default ${key} = ${parsed}`, "info");
        return;
      }

      // /params <model> <key> <value> — set model-specific param
      if (parts.length === 4 && parts[0].startsWith("m:")) {
        const [, model, key, value] = parts;
        const parsed = parseParamValue(value);
        config.models = config.models ?? {};
        config.models[model] = { ...config.models[model], [key]: parsed };
        saveConfig(config);
        ctx.ui.notify(`Set ${model} ${key} = ${parsed}`, "info");
        return;
      }

      ctx.ui.notify(
        "Usage:\n" +
          "  /params                        — show current params\n" +
          "  /params <key> <value>          — set global default\n" +
          "  /params m:<model> <key> <val>  — set model-specific\n" +
          "  /params reset                  — clear all\n" +
          "  /params reset <model>          — clear model-specific",
        "warning"
      );
    },
  });
}

function parseParamValue(value: string): number | string | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (!isNaN(Number(value))) return Number(value);
  return value;
}
