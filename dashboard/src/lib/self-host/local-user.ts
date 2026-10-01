import {
  localOperatorEmail,
  localOperatorName,
  SELF_HOST_USER_ID,
} from "./config";

// The operator's email is the address they set up their own install with and
// sign in to with a password, so it counts as verified for the ops-admin check
// (lib/ops-access.ts verifiedPrimaryEmailOf).
type LocalEmailAddress = { emailAddress: string; id: string; verification: { status: "verified" } };

export interface LocalOperatorUser {
  createdAt: Date;
  emailAddresses: LocalEmailAddress[];
  firstName: string;
  fullName: string;
  id: typeof SELF_HOST_USER_ID;
  lastName: null;
  lastSignInAt: Date;
  primaryEmailAddress: LocalEmailAddress;
  primaryEmailAddressId: string;
  publicMetadata: Record<string, unknown>;
}

export function createLocalOperatorUser(
  publicMetadata: Record<string, unknown> = {},
): LocalOperatorUser {
  const email = localOperatorEmail();
  const name = localOperatorName();
  const emailAddress: LocalEmailAddress = {
    id: "hivra-local-email",
    emailAddress: email,
    verification: { status: "verified" },
  };
  return {
    id: SELF_HOST_USER_ID,
    firstName: name,
    lastName: null,
    fullName: name,
    primaryEmailAddressId: emailAddress.id,
    primaryEmailAddress: emailAddress,
    emailAddresses: [emailAddress],
    publicMetadata,
    createdAt: new Date(0),
    lastSignInAt: new Date(),
  };
}
