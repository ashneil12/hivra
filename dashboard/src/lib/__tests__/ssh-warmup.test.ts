import {
  isSshWarmupError,
  normalizeSshWarmupMessage,
  SSH_WARMUP_MESSAGE,
} from "@/lib/ssh-warmup";

describe("ssh-warmup", () => {
  it("treats SSH ETIMEDOUT connection errors as retryable warmup failures", () => {
    expect(
      isSshWarmupError("SSH connection error: connect ETIMEDOUT 203.0.113.185:22")
    ).toBe(true);
  });

  it("treats other transient network errors as retryable warmup failures too", () => {
    expect(
      isSshWarmupError("SSH connection error: connect ECONNREFUSED 203.0.113.185:22")
    ).toBe(true);
    expect(
      isSshWarmupError("SSH connection error: connect EHOSTUNREACH 203.0.113.185:22")
    ).toBe(true);
  });

  it("normalizes raw fingerprint capture failures into the shared warmup message", () => {
    expect(
      normalizeSshWarmupMessage(
        "Redeploy failed: SSH fingerprint capture failed: connect ETIMEDOUT 203.0.113.185:22"
      )
    ).toBe(SSH_WARMUP_MESSAGE);
  });

  it("leaves unrelated errors untouched", () => {
    expect(normalizeSshWarmupMessage("SSH connection error: fingerprint mismatch")).toBe(
      "SSH connection error: fingerprint mismatch"
    );
  });
});
