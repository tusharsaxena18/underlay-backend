


import { GoogleGenAI } from '@google/genai';
import { GeminiKeyManager } from '../../../services/keyManager';

const RETRYABLE_STATUSES = [429, 500, 503, 504];
const NETWORK_CODES = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'];
const isNetworkError = (err: any) =>
  err?.status === undefined &&
  (err?.message === 'fetch failed' ||
    NETWORK_CODES.includes(err?.cause?.code) ||
    NETWORK_CODES.includes(err?.code));

export function safeParseJson(text: string): any | null {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/**
 * Single place for key rotation, retries with backoff, and model fallback.
 * Used by ingestion, field mapper, moat classifier and reasoning.
 * Uses the unchanged GeminiKeyManager for round-robin; cooldowns for keys that hit a 429
 * are tracked here, per key and per model.
 *
 * Latency tuning: only 2 attempts per model with short backoff, so an overloaded model costs
 * about a second before the fallback model gets its turn.
 */
export class GeminiClient {
  private keyManager: GeminiKeyManager;
  private models: string[];
  private cooldownUntil = new Map<string, number>(); // "key|model" -> timestamp (ms)

  constructor() {
    const envKeys: string[] = [];
    if (process.env.GEMINI_API_KEY) envKeys.push(process.env.GEMINI_API_KEY);
    Object.keys(process.env).forEach((envVar) => {
      if (envVar.startsWith('GEMINI_KEY_') && process.env[envVar]) {
        envKeys.push(process.env[envVar] as string);
      }
    });

    if (envKeys.length === 0) {
      throw new Error(
        'No Gemini API keys found. Set GEMINI_API_KEY or GEMINI_KEY_1, GEMINI_KEY_2, ... in your .env'
      );
    }

    this.keyManager = new GeminiKeyManager(envKeys);
    this.models = Array.from(
      new Set([process.env.GEMINI_MODEL || 'gemini-3.8-flash', process.env.GEMINI_FALLBACK_MODEL || ''].filter(Boolean))
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Next round-robin key that is not on cooldown for this model, or null if every key is cooling down. */
  private pickKey(model: string): string | null {
    const now = Date.now();
    for (let i = 0; i < this.keyManager.size; i++) {
      const key = this.keyManager.getNextKey();
      if ((this.cooldownUntil.get(`${key}|${model}`) ?? 0) <= now) return key;
    }
    return null;
  }

  async generate(
    label: string,
    parts: any[],
    config: Record<string, any> = {}
  ): Promise<{ text: string; model: string }> {
    const maxAttempts = 2;
    let lastError: any;

    for (const model of this.models) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const apiKey = this.pickKey(model);
        if (!apiKey) {
          console.warn(`[${label}] All keys are rate-limited for ${model}, trying next model.`);
          break;
        }

        try {
          const ai = new GoogleGenAI({ apiKey });
          const response: any = await ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts }],
            config,
          });
          // An empty answer from an overloaded model is treated as a transient failure.
          if (!response.text) throw Object.assign(new Error('Empty response from model'), { status: 503 });
          return { text: response.text, model };
        } catch (err: any) {
          lastError = err;

          if (err?.status === 404) {
            console.warn(`[${label}] Model ${model} returned 404, trying next model.`);
            break;
          }

          // Quota exhausted: cool this key down for as long as Google says, then rotate immediately.
          if (err?.status === 429) {
            const match = String(err?.message).match(/"retryDelay":"(\d+(?:\.\d+)?)s"/);
            const cooldownMs = (match ? Number(match[1]) : 60) * 1000;
            this.cooldownUntil.set(`${apiKey}|${model}`, Date.now() + cooldownMs);
            console.warn(
              `[${label}] ${model} returned 429 on this key; skipping it for ${Math.round(cooldownMs / 1000)}s.`
            );
            if (attempt === maxAttempts) break;
            continue;
          }

          if (!RETRYABLE_STATUSES.includes(err?.status) && !isNetworkError(err)) throw err;
          if (attempt === maxAttempts) {
            console.warn(`[${label}] ${model} still failing after ${maxAttempts} attempts.`);
            break;
          }

          const delay = Math.min(500 * 2 ** (attempt - 1), 4000) + Math.random() * 300;
          console.warn(
            `[${label}] ${model} returned ${err.status ?? 'a network error'} (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(delay)}ms`
          );
          await this.sleep(delay);
        }
      }
    }

    throw lastError ?? new Error('All Gemini keys are rate-limited for every configured model. Try again later.');
  }

  async generateJson<T = any>(
    label: string,
    parts: any[],
    config: Record<string, any> = {}
  ): Promise<{ data: T; model: string }> {
    const { text, model } = await this.generate(label, parts, { responseMimeType: 'application/json', ...config });
    const data = safeParseJson(text);
    if (data === null) {
      throw new Error(`[${label}] Gemini returned non-JSON output: ${text.slice(0, 200)}`);
    }
    return { data: data as T, model };
  }
}

let instance: GeminiClient | null = null;
/** Lazy singleton so dotenv has loaded before the keys are read. */
export function getGeminiClient(): GeminiClient {
  if (!instance) instance = new GeminiClient();
  return instance;
}