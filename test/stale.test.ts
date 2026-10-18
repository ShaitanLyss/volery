import { describe, expect, test } from "bun:test";
import { staleArtifact } from "../tools/stale";

describe("staleArtifact", () => {
  test("invalid metadata", () => {
    const out = "error[E0786]: found invalid metadata files for crate `skein_lib`\n";
    expect(staleArtifact(out)).toBe("invalid metadata files");
  });
  test("rlib not found", () => {
    const out = "error: crate `serde_json` required to be available in rlib format, but was not found in this form\n";
    expect(staleArtifact(out)).toBe("rlib not found in this form");
  });
  test("a real compile error is not stale", () => {
    const out = "error[E0004]: non-exhaustive patterns: `Frame::Move` not covered\n --> examples/flyway-link.rs:10:11\n";
    expect(staleArtifact(out)).toBeNull();
  });
  test("a real test failure is not stale", () => {
    const out = "test store::tests::x ... FAILED\n\ntest result: FAILED. 3 passed; 1 failed; 0 ignored\n";
    expect(staleArtifact(out)).toBeNull();
  });
});
