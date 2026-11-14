import {
  HEARD_ABOUT_OPTIONS,
  buildHeardAboutAnswer,
  buildSignupUnsafeMetadata,
  cleanSignupAttribution,
  readHeardAboutAnswer,
} from "@/lib/signup/heard-about";
import { findBannedClaims } from "@/lib/tools/copy-rules";

describe("How did you hear about Hivra?", () => {
  it("offers unique values and labels that pass the public copy rules", () => {
    const values = HEARD_ABOUT_OPTIONS.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values[values.length - 1]).toBe("other");
    for (const { label } of HEARD_ABOUT_OPTIONS) {
      expect(findBannedClaims(label)).toEqual([]);
    }
  });

  it("treats an empty or unknown choice as skipped", () => {
    expect(buildHeardAboutAnswer("")).toBeNull();
    expect(buildHeardAboutAnswer("billboard")).toBeNull();
  });

  it("keeps free text only for Somewhere else, squashed and capped at 100 characters", () => {
    expect(buildHeardAboutAnswer("x", "ignored")).toEqual({ heard_about: "x" });
    expect(buildHeardAboutAnswer("other", "   ")).toEqual({ heard_about: "other" });
    expect(buildHeardAboutAnswer("other", " a\n\npodcast ")).toEqual({ heard_about: "other", heard_about_other: "a podcast" });
    expect(buildHeardAboutAnswer("other", "y".repeat(500))?.heard_about_other).toHaveLength(100);
  });

  it("reads back only known answers from Clerk unsafe metadata", () => {
    expect(readHeardAboutAnswer(null)).toBeNull();
    expect(readHeardAboutAnswer({ heard_about: 7 })).toBeNull();
    expect(readHeardAboutAnswer({ heard_about: "nope" })).toBeNull();
    expect(readHeardAboutAnswer({ heard_about: "github", other: "x" })).toEqual({ heard_about: "github" });
  });

  it("keeps only the first-touch keys in the attribution it saves", () => {
    expect(cleanSignupAttribution("nope")).toEqual({});
    expect(cleanSignupAttribution({ utm_source: "x", referrer: "", captured_at: 1, email: "a@b.c", landing_page: "/".repeat(300) })).toEqual({
      utm_source: "x",
      landing_page: "/".repeat(256),
    });
    expect(buildSignupUnsafeMetadata(null, {})).toEqual({});
    expect(buildSignupUnsafeMetadata({ heard_about: "search" }, { utm_source: "g" })).toEqual({
      heard_about: "search",
      signup_attribution: { utm_source: "g" },
    });
  });
});
