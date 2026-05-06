import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";

const COOKIE_NAME = "chapter_ai_sid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

/**
 * Get or create an anonymous session id, persisted in an httpOnly cookie.
 * Used to scope jobs to a visitor until real auth lands.
 * MUST be called from a Server Action, Route Handler, or Server Component
 * that can mutate the cookie store.
 */
export async function getOrCreateSessionId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE_NAME)?.value;
  if (existing && existing.length >= 32) return existing;

  const sid = randomUUID();
  jar.set(COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return sid;
}

/** Read-only: returns the session id if one exists, else null. */
export async function getSessionId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(COOKIE_NAME)?.value ?? null;
}
