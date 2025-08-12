// /api/_lib/redis.ts
import { Redis } from '@upstash/redis';

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Helpers opcionales
export async function kvGet<T = string>(key: string): Promise<T | null> {
  return (await redis.get<T>(key)) ?? null;
}
export async function kvSet(key: string, value: string, ttlSec?: number) {
  if (ttlSec) return redis.set(key, value, { ex: ttlSec });
  return redis.set(key, value);
}
export async function kvPush(key: string, ...vals: string[]) {
  // guardamos nuevo al final
  return redis.rpush(key, vals);
}
