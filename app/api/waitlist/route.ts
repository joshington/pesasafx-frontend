
// app/api/waitlist/route.ts
// Receives waitlist signups from the landing page and writes them to a Google Sheet
// through a Google Apps Script web app. No email service needed.
//
// Environment variables (.env.local, and your hosting dashboard):
//   GOOGLE_SHEET_WEBHOOK_URL   Apps Script web app URL (ends in /exec)
//   GOOGLE_SHEET_SECRET        same secret string you put in Code.gs

import { NextResponse } from "next/server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Best-effort rate limit (per server instance).
const hits = new Map<string, { count: number; reset: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_HITS = 5;

function rateLimited(ip: string) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || rec.reset < now) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_HITS;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Hidden honeypot field: bots fill it. Pretend success and drop it.
  if (body.website) return NextResponse.json({ ok: true });

  const entry = {
    name: oneLine(String(body.name ?? "")).slice(0, 120),
    email: oneLine(String(body.email ?? "")).toLowerCase().slice(0, 254),
    company: oneLine(String(body.company ?? "")).slice(0, 160),
    corridor: oneLine(String(body.corridor ?? "")).slice(0, 60),
    volume: oneLine(String(body.volume ?? "")).slice(0, 40),
    notes: String(body.notes ?? "").trim().slice(0, 2000),
  };

  if (!entry.name || !entry.company || !EMAIL_RE.test(entry.email)) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const url = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  const secret = process.env.GOOGLE_SHEET_SECRET;
  if (!url || !secret) {
    console.error("[waitlist] Missing GOOGLE_SHEET_WEBHOOK_URL or GOOGLE_SHEET_SECRET");
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...entry, secret }),
      redirect: "follow",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(`Sheet webhook failed: ${data?.error ?? res.status}`);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[waitlist] sheet save failed:", err);
    return NextResponse.json({ error: "Could not save signup" }, { status: 502 });
  }
}