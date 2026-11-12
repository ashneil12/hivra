// Off-by-default switch for the OpenBot agent type. Client-safe: the NEXT_PUBLIC
// value is inlined at build time, so read it by its literal name.

export function isOpenBotAgentEnabled(value: string | undefined = process.env.NEXT_PUBLIC_HIVRA_OPENBOT_AGENT): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}
