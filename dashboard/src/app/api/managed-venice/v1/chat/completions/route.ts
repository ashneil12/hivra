import type { NextRequest } from "next/server";
import { managedChatPost } from "@/lib/venice/proxy-chat-route";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  return managedChatPost(request);
}
