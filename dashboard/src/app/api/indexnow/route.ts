import crypto from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { getSiteUrls, SITE_URL } from "@/lib/seo-urls";

// SCRIPTURE_ANCHOR: indexnow-declare | Isaiah 52:7 | Verse: How beautiful on the mountains are the feet of him who brings good news.
function timingSafeStringEqual(received: string, expected: string): boolean {
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const { userId } = await auth();

  const { searchParams } = new URL(request.url);
  const triggerSecret = searchParams.get("secret");
  const configuredTriggerSecret = process.env.INDEXNOW_TRIGGER_SECRET;

  if (!userId) {
    if (
      !configuredTriggerSecret ||
      typeof triggerSecret !== "string" ||
      !timingSafeStringEqual(triggerSecret, configuredTriggerSecret)
    ) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }
  }

  // Per-IP cap to keep a leaked trigger secret (or a curious authed user)
  // from spamming IndexNow with our entire sitemap and getting the domain
  // rate-limited or temporarily delisted. 1 request/min/IP is plenty —
  // sitemap submission is a low-frequency operation.
  const ip = getIP(request);
  const rateLimit = enforceRateLimit(`indexnow:${ip}`, { limit: 1, windowMs: 60_000 });
  if (!rateLimit.success) {
    return NextResponse.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const INDEXNOW_PUBLIC_KEY = process.env.INDEXNOW_KEY?.trim();

  if (!INDEXNOW_PUBLIC_KEY) {
    return NextResponse.json(
      { error: "IndexNow key is not configured" },
      { status: 500 }
    );
  }

  try {
    // Generate all latest URLs
    const sitemapData = getSiteUrls();
    const urlList = sitemapData.map((sitemapObj) => sitemapObj.url);

    // Prepare payload for IndexNow
    // Hostname without protocol
    const host = new URL(SITE_URL).hostname;

    const payload = {
      host: host,
      key: INDEXNOW_PUBLIC_KEY,
      keyLocation: `${SITE_URL}/${INDEXNOW_PUBLIC_KEY}.txt`,
      urlList: urlList,
    };

    const indexNowResponse = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });

    const statusCode = indexNowResponse.status;

    if (indexNowResponse.ok) {
      return NextResponse.json({
        success: true,
        message: "IndexNow submission successful",
        statusCode,
        urlsSubmitted: urlList.length,
      });
    } else {
      await indexNowResponse.text();
      return apiError("IndexNow submission failed", 500, {
        failureType: "indexnow_submission_failed",
        upstreamStatus: statusCode,
      }, {
        statusCode,
      });
    }
  } catch {
    return apiError("IndexNow submission failed", 500, {
      failureType: "indexnow_submission_failed",
    });
  }
}
