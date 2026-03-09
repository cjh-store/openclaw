import {
  dedupeProfileIds,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "../agents/auth-profiles.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { resolveUsableCustomProviderApiKey } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { resolveProviderUsageAuthWithPlugin } from "../plugins/provider-runtime.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { resolveLegacyPiAgentAccessToken } from "./provider-usage.shared.js";
import type { UsageProviderId } from "./provider-usage.types.js";

export type ProviderAuth = {
  provider: UsageProviderId;
  token: string;
  accountId?: string;
  profileId?: string;
};

type AuthStore = ReturnType<typeof ensureAuthProfileStore>;

type UsageAuthState = {
  cfg: OpenClawConfig;
  store: AuthStore;
  env: NodeJS.ProcessEnv;
  agentDir?: string;
};

function parseGoogleUsageToken(apiKey: string): string {
  try {
    const parsed = JSON.parse(apiKey) as { token?: unknown };
    if (typeof parsed?.token === "string") {
      return parsed.token;
    }
  } catch {
    // ignore
  }
  return apiKey;
}

function resolveProviderApiKeyFromConfigAndStore(params: {
  state: UsageAuthState;
  providerIds: string[];
  envDirect?: Array<string | undefined>;
}): string | undefined {
  const envDirect = params.envDirect?.map(normalizeSecretInput).find(Boolean);
  if (envDirect) {
    return envDirect;
  }

  for (const providerId of params.providerIds) {
    const key = resolveUsableCustomProviderApiKey({
      cfg: params.state.cfg,
      provider: providerId,
    })?.apiKey;
    if (key) {
      return key;
    }
  }

  const normalizedProviderIds = new Set(
    params.providerIds.map((providerId) => normalizeProviderId(providerId)).filter(Boolean),
  );
  const cred = [...normalizedProviderIds]
    .flatMap((providerId) => listProfilesForProvider(params.state.store, providerId))
    .map((id) => params.state.store.profiles[id])
    .find(
      (
        profile,
      ): profile is
        | { type: "api_key"; provider: string; key: string }
        | { type: "token"; provider: string; token: string } =>
        profile?.type === "api_key" || profile?.type === "token",
    );
  if (!cred) {
    return undefined;
  }
  if (cred.type === "api_key") {
    const key = normalizeSecretInput(cred.key);
    if (key && !isNonSecretApiKeyMarker(key)) {
      return key;
    }
    return undefined;
  }
  const token = normalizeSecretInput(cred.token);
  if (token && !isNonSecretApiKeyMarker(token)) {
    return token;
  }
  return undefined;
}

async function resolveAllOAuthTokens(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
}): Promise<ProviderAuth[]> {
  const order = resolveAuthProfileOrder({
    cfg: params.state.cfg,
    store: params.state.store,
    provider: params.provider,
  });
  const deduped = dedupeProfileIds(order);
  const auths: ProviderAuth[] = [];

  for (const profileId of deduped) {
    const cred = params.state.store.profiles[profileId];
    if (!cred || (cred.type !== "oauth" && cred.type !== "token")) {
      continue;
    }
    try {
      const resolved = await resolveApiKeyForProfile({
        // Reuse the already-resolved config snapshot for token/ref resolution so
        // usage snapshots don't trigger a second ambient loadConfig() call.
        cfg: params.state.cfg,
        store: params.state.store,
        profileId,
        agentDir: params.state.agentDir,
      });
      if (!resolved) {
        continue;
      }
      let token = resolved.apiKey;
      if (params.provider === "google-gemini-cli") {
        token = parseGoogleUsageToken(resolved.apiKey);
      }
      auths.push({
        provider: params.provider,
        token,
        profileId,
        accountId:
          cred.type === "oauth" && "accountId" in cred
            ? (cred as { accountId?: string }).accountId
            : undefined,
      });
    } catch {
      // ignore
    }
  }

  return auths;
}

async function resolveProviderUsageAuthViaPlugin(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
}): Promise<ProviderAuth | null> {
  const resolved = await resolveProviderUsageAuthWithPlugin({
    provider: params.provider,
    config: params.state.cfg,
    env: params.state.env,
    context: {
      config: params.state.cfg,
      agentDir: params.state.agentDir,
      env: params.state.env,
      provider: params.provider,
      resolveApiKeyFromConfigAndStore: (options) =>
        resolveProviderApiKeyFromConfigAndStore({
          state: params.state,
          providerIds: options?.providerIds ?? [params.provider],
          envDirect: options?.envDirect,
        }),
      resolveOAuthToken: async () => {
        const auth = (await resolveAllOAuthTokens({
          state: params.state,
          provider: params.provider,
        }))[0];
        return auth
          ? {
              token: auth.token,
              ...(auth.accountId ? { accountId: auth.accountId } : {}),
            }
          : null;
      },
    },
  });
  if (!resolved?.token) {
    return null;
  }
  return {
    provider: params.provider,
    token: resolved.token,
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
  };
}

async function resolveProviderUsageAuthFallback(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
}): Promise<ProviderAuth[]> {
  switch (params.provider) {
    case "anthropic":
    case "github-copilot":
    case "openai-codex":
    case "google-gemini-cli":
      return await resolveAllOAuthTokens(params);
    case "zai": {
      const apiKey = resolveProviderApiKeyFromConfigAndStore({
        state: params.state,
        providerIds: ["zai", "z-ai"],
        envDirect: [params.state.env.ZAI_API_KEY, params.state.env.Z_AI_API_KEY],
      });
      if (apiKey) {
        return [{ provider: "zai", token: apiKey }];
      }
      const legacyToken = resolveLegacyPiAgentAccessToken(params.state.env, ["z-ai", "zai"]);
      return legacyToken ? [{ provider: "zai", token: legacyToken }] : [];
    }
    case "minimax": {
      const apiKey = resolveProviderApiKeyFromConfigAndStore({
        state: params.state,
        providerIds: ["minimax"],
        envDirect: [params.state.env.MINIMAX_CODE_PLAN_KEY, params.state.env.MINIMAX_API_KEY],
      });
      return apiKey ? [{ provider: "minimax", token: apiKey }] : [];
    }
    case "xiaomi": {
      const apiKey = resolveProviderApiKeyFromConfigAndStore({
        state: params.state,
        providerIds: ["xiaomi"],
        envDirect: [params.state.env.XIAOMI_API_KEY],
      });
      return apiKey ? [{ provider: "xiaomi", token: apiKey }] : [];
    }
    default:
      return [];
  }
}

export async function resolveProviderAuths(params: {
  providers: UsageProviderId[];
  auth?: ProviderAuth[];
  agentDir?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderAuth[]> {
  if (params.auth) {
    return params.auth;
  }

  const state: UsageAuthState = {
    cfg: params.config ?? loadConfig(),
    store: ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    }),
    env: params.env ?? process.env,
    agentDir: params.agentDir,
  };
  const auths: ProviderAuth[] = [];

  for (const provider of params.providers) {
    const pluginAuth = await resolveProviderUsageAuthViaPlugin({
      state,
      provider,
    });
    if (pluginAuth) {
      auths.push(pluginAuth);
      continue;
    }
    const fallbackAuths = await resolveProviderUsageAuthFallback({
      state,
      provider,
    });
    auths.push(...fallbackAuths);
  }

  return auths;
}
