/**
 * Where a public "start" link sends someone: sign up, then Launch.
 *
 * Launch asks where the agent or computer runs before anything else. The Free
 * plan is turned on there, with its own button, only for a launch on Hivra
 * Cloud, so a person bringing their own cloud or server is never sent through
 * a plan or a checkout first. A signed-in visitor goes straight to Launch.
 *
 * A link for one paid plan (a pricing card) keeps /get-started?plan=<plan>,
 * which carries that plan through checkout.
 */
export const PUBLIC_START_HREF = "/sign-up";
