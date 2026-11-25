import { describe, expect, test } from "bun:test";
import {
    dockerCopyInArgs,
    dockerCopyOutArgs,
    dockerExecArgs,
    dockerRunArgs,
} from "../../packages/sandbox/src/docker.ts";
import { sbxExecArgs, sbxRemote } from "../../packages/sandbox/src/sbx.ts";

describe("docker backend", () => {
    test("exec runs a fresh bash in the existing container", () => {
        const args = dockerExecArgs("agent-1", "pwd", "/work", 120, false);

        expect(args.slice(0, 5)).toEqual(["exec", "-w", "/work", "agent-1", "timeout"]);
        expect(args).not.toContain("-i");
        expect(args.slice(-3)).toEqual(["bash", "-lc", "pwd"]);
        expect(args).toContain("120s");
    });

    test("exec keeps stdin open only when a payload is provided", () => {
        expect(dockerExecArgs("agent-1", "cat", "/work", 5, true)).toContain("-i");
    });

    test("run creates a hardened, persistent container", () => {
        const args = dockerRunArgs("agent-1", "eien/sandbox:local", "/work", "bridge");

        expect(args.slice(0, 2)).toEqual(["run", "-d"]);
        expect(args).toContain("--name");
        expect(args).toContain("agent-1");
        expect(args).toContain("--init");
        expect(args).toContain("--cap-drop");
        expect(args).toContain("ALL");
        expect(args).toContain("no-new-privileges");
        expect(args).toContain("--shm-size");
        expect(args.slice(-2)).toEqual(["sleep", "infinity"]);
        expect(args).not.toContain("--network");
    });

    test("run can isolate the network", () => {
        const args = dockerRunArgs("agent-1", "img", "/work", "none");
        const index = args.indexOf("--network");
        expect(args.slice(index, index + 2)).toEqual(["--network", "none"]);
    });

    test("copy goes through the container, in both directions", () => {
        expect(dockerCopyInArgs("agent-1", "/tmp/a", "/work/a")).toEqual(["cp", "/tmp/a", "agent-1:/work/a"]);
        expect(dockerCopyOutArgs("agent-1", "/work/a", "/tmp/a")).toEqual(["cp", "agent-1:/work/a", "/tmp/a"]);
    });
});

describe("sbx backend", () => {
    test("exec enters the workspace with -w", () => {
        expect(sbxExecArgs("agent-1", "ls", "/work")).toEqual(["exec", "-w", "/work", "agent-1", "bash", "-lc", "ls"]);
    });

    test("exec omits -w without a cwd", () => {
        expect(sbxExecArgs("agent-1", "ls")).toEqual(["exec", "agent-1", "bash", "-lc", "ls"]);
    });

    test("remote paths use the sandbox prefix", () => {
        expect(sbxRemote("agent-1", "/work/a.txt")).toBe("agent-1:/work/a.txt");
    });
});
