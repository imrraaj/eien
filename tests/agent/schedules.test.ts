import { describe, expect, test } from "bun:test";
import { planSchedule } from "../../packages/agent/src/schedules.ts";

const rejection = (request: Parameters<typeof planSchedule>[0], taken = new Set<string>()) => {
    const planned = planSchedule(request, taken);
    if (planned.isOk()) throw new Error("expected a rejection");
    expect(planned.error._tag).toBe("ScheduleRejected");
    return planned.error.message;
};

describe("planSchedule", () => {
    test("plans one-shot and repeating schedules", () => {
        expect(planSchedule({ name: "a", prompt: "p", delay: "2m" }, new Set()).unwrap()).toEqual({
            name: "a",
            prompt: "p",
            delayMs: 120_000,
            everyMs: undefined,
        });
        expect(planSchedule({ name: "b", prompt: "p", delay: "30s", every: "1h" }, new Set()).unwrap().everyMs).toBe(
            3_600_000,
        );
    });

    test("rejects bad input with a message for the model", () => {
        expect(rejection({ name: "a", delay: "2m" })).toBe("add needs a prompt.");
        expect(rejection({ name: "a", prompt: "p", delay: "soon" })).toContain("invalid delay");
        expect(rejection({ name: "a", prompt: "p", delay: "31d" })).toContain("too long");
        expect(rejection({ name: "a", prompt: "p", delay: "1m", every: "often" })).toContain("invalid repeat");
        expect(rejection({ name: "a", prompt: "p", delay: "1m", every: "5s" })).toContain("at least 10s");
        expect(rejection({ name: "a", prompt: "p", delay: "1m" }, new Set(["a"]))).toContain("already exists");
    });
});
