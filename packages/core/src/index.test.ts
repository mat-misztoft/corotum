import { describe, expect, test } from "bun:test";
import {
  type ActualState,
  type DesiredStateEnvelope,
  type Result,
  revisionId,
  type StateProvider,
  skillId,
} from "./index";

describe("portable core domain primitives", () => {
  test("keeps opaque skill IDs stable through serialization independent of display names", () => {
    const id = skillId("sk_01JXYZ");
    const serialized = JSON.stringify({ id, skill: "frontend-design" });
    const restored = JSON.parse(serialized) as { id: string; skill: string };

    expect(restored).toEqual({ id: "sk_01JXYZ", skill: "frontend-design" });
    expect(skillId(restored.id)).toBe(id);
    expect(skillId("sk_01JABC")).not.toBe(id);
  });

  test("rejects malformed stable skill IDs", () => {
    expect(() => skillId("frontend-design")).toThrow("sk_<opaque identifier>");
    expect(() => skillId("sk_")).toThrow("sk_<opaque identifier>");
  });

  test("represents desired, actual, and every provider failure vocabulary portably", async () => {
    const desired = { manifest: { skills: [] }, lockfile: { skills: [] } };
    const actual: ActualState = {
      skills: { [skillId("sk_01JXYZ")]: { contentHash: null, managed: false } },
    };
    const envelope: DesiredStateEnvelope = {
      revisionId: revisionId("42"),
      state: desired,
    };
    const outcomes: readonly Result<DesiredStateEnvelope>[] = [
      { kind: "success", value: envelope },
      {
        kind: "partial",
        value: envelope,
        errors: [{ code: "DEVICE_ERROR", message: "one target failed" }],
      },
      { kind: "failure", error: { code: "CONFLICT", message: "stale" } },
      { kind: "failure", error: { code: "AUTH_REQUIRED", message: "login" } },
      {
        kind: "failure",
        error: { code: "VALIDATION_ERROR", message: "invalid input" },
      },
    ];
    const provider: StateProvider = {
      pull: async () => outcomes[0],
      push: async () => outcomes[0],
    };

    expect(actual.skills[skillId("sk_01JXYZ")]?.managed).toBeFalse();
    expect(await provider.pull()).toEqual(outcomes[0]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "success",
      "partial",
      "failure",
      "failure",
      "failure",
    ]);
  });
});
