"use client";

import { SignUp } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { type ComponentProps, useId, useMemo, useState } from "react";
import {
  HEARD_ABOUT_OPTIONS,
  HEARD_ABOUT_OTHER_MAX_LENGTH,
  buildHeardAboutAnswer,
  buildSignupUnsafeMetadata,
  readStoredSignupAttribution,
} from "@/lib/signup/heard-about";
import styles from "./sign-up.module.css";

type HeardAboutSignUpProps = {
  fallbackRedirectUrl: string;
  appearance: ComponentProps<typeof SignUp>["appearance"];
};

// The Clerk card plus one optional question above it. Clerk saves unsafeMetadata
// on the user it creates (email and OAuth alike) and the mounted card picks up a
// changed prop, so the answer only has to be in state before the visitor submits.
// The question shows on the first step only: once the sign-up exists
// (verify-email-address, continue, sso-callback) changing it would do nothing.
export default function HeardAboutSignUp({ fallbackRedirectUrl, appearance }: HeardAboutSignUpProps) {
  const pathname = usePathname();
  const selectId = useId();
  const otherId = useId();
  const [heardAbout, setHeardAbout] = useState("");
  const [other, setOther] = useState("");
  // The first-touch stash is read again with each answer, so a stash the page
  // view wrote after this first rendered is still picked up. It is never
  // rendered, so the server's empty read cannot cause a hydration mismatch.
  const unsafeMetadata = useMemo(
    () => buildSignupUnsafeMetadata(buildHeardAboutAnswer(heardAbout, other), readStoredSignupAttribution()),
    [heardAbout, other],
  );

  const firstStep = !pathname || pathname.replace(/\/+$/, "") === "/sign-up";

  return (
    <>
      {firstStep ? (
        <div className={styles.heardAbout}>
          <label htmlFor={selectId}>
            How did you hear about Hivra? <span>Optional</span>
          </label>
          <select id={selectId} name="heard_about" value={heardAbout} onChange={(event) => setHeardAbout(event.target.value)}>
            <option value="">Choose one</option>
            {HEARD_ABOUT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {heardAbout === "other" ? (
            <>
              <label htmlFor={otherId} className={styles.visuallyHidden}>
                Where did you hear about Hivra?
              </label>
              <input
                id={otherId}
                name="heard_about_other"
                type="text"
                value={other}
                maxLength={HEARD_ABOUT_OTHER_MAX_LENGTH}
                placeholder="Where? (optional)"
                autoComplete="off"
                onChange={(event) => setOther(event.target.value)}
              />
            </>
          ) : null}
        </div>
      ) : null}
      <SignUp fallbackRedirectUrl={fallbackRedirectUrl} appearance={appearance} unsafeMetadata={unsafeMetadata} />
    </>
  );
}
