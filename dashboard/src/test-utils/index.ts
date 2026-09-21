/**
 * Shared test utilities.
 *
 * Import from "@/test-utils" rather than hand-rolling mocks: 213 test files
 * stub Supabase, 135 Clerk, 108 the logger, and 178 build requests inline.
 */
export * from "./supabase";
export * from "./clerk";
export * from "./logger";
export * from "./request";
export * from "./console";
export * from "./env";
export * from "./fixtures";
