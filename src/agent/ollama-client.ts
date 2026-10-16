import { Agent, fetch as undiciFetch } from 'undici';

// Local models can take minutes per response; Node's default five-minute limits would cause fetch failures.
const patientDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 });
export const patientFetch = ((url: string, init?: RequestInit) =>
  undiciFetch(url, { ...init, dispatcher: patientDispatcher } as never)) as unknown as typeof fetch;

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen3.5:9b';

const DEFAULT_CONTEXT = 16_384;
const DEVELOPER_CONTEXT = 32_768;

/** Resolve a role-specific model before the global override and the default model. */
export function resolveModel(role: string, environment: NodeJS.ProcessEnv = process.env): string {
  const roleKey = `DEV_LOG_OLLAMA_MODEL_${role.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return environment[roleKey]?.trim() || environment.DEV_LOG_OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
}

/** Resolve a role-specific context size before the global override and role default. */
export function resolveContext(role: string, environment: NodeJS.ProcessEnv = process.env): number {
  const roleKey = `DEV_LOG_OLLAMA_CTX_${role.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const configured = Number(environment[roleKey] ?? environment.DEV_LOG_OLLAMA_CTX);
  if (Number.isInteger(configured) && configured >= 2_048 && configured <= 131_072) return configured;
  return role === 'developer' ? DEVELOPER_CONTEXT : DEFAULT_CONTEXT;
}

export function requestOllamaChat(
  fetchImpl: typeof fetch,
  baseUrl: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  return fetchImpl(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(payload),
  });
}
