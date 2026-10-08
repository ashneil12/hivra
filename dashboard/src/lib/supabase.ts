import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// There is deliberately no anon-key client here. The dashboard reaches the
// database only as the service role, from the server. A NEXT_PUBLIC_ anon-key
// client would be inlined into the browser bundle by any client component that
// imports it, and would rely on RLS alone to protect every table. The anon key
// is still accepted as configuration (the self-host script probes the local API
// with it) but no application source reads it;
// supabase-client-and-config-hardening.test.ts keeps it that way.

/** Server-side admin client (service role key) — null if not configured */
export const supabaseAdmin =
  typeof window === "undefined" && supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey, {
        auth: { persistSession: false },
      })
    : null;
