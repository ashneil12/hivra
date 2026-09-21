import {
  localOperatorEmail,
  localOperatorName,
  SELF_HOST_USER_ID,
} from "./config";

export interface LocalOperatorUser {
  createdAt: Date;
  emailAddresses: Array<{ emailAddress: string; id: string }>;
  firstName: string;
  fullName: string;
  id: typeof SELF_HOST_USER_ID;
  lastName: null;
  lastSignInAt: Date;
  primaryEmailAddress: { emailAddress: string; id: string };
  primaryEmailAddressId: string;
  publicMetadata: Record<string, unknown>;
}

export function createLocalOperatorUser(
  publicMetadata: Record<string, unknown> = {},
): LocalOperatorUser {
  const email = localOperatorEmail();
  const name = localOperatorName();
  const emailAddress = { id: "hivra-local-email", emailAddress: email };
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
