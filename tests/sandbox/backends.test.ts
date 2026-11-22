import { describe, expect, test } from "bun:test";
import { sbxExecArgs, sbxRemote } from "../../packages/sandbox/src/sbx.ts";
import { scpArgs, sshArgs, sshCommand, sshRemote, sshScript } from "../../packages/sandbox/src/ssh.ts";
import type { SshOptions } from "../../packages/sandbox/src/types.ts";

const ssh: SshOptions = {
  host: "sandbox",
  user: "agent",
  port: 2222,
  keyPath: "/keys/id_ed25519",
  knownHostsPath: "/keys/known_hosts",
};

describe("sbx backend", () => {
  test("exec enters the workspace with -w", () => {
    expect(sbxExecArgs("agent-1", "ls", "/work")).toEqual([
      "exec",
      "-w",
      "/work",
      "agent-1",
      "bash",
      "-lc",
      "ls",
    ]);
  });

  test("exec omits -w without a cwd", () => {
    expect(sbxExecArgs("agent-1", "ls")).toEqual(["exec", "agent-1", "bash", "-lc", "ls"]);
  });

  test("remote paths use the sandbox prefix", () => {
    expect(sbxRemote("agent-1", "/work/a.txt")).toBe("agent-1:/work/a.txt");
  });
});

describe("ssh backend", () => {
  test("ssh options pin the key and host key", () => {
    const args = sshArgs(ssh);
    expect(args).toContain("-T");
    expect(args).toContain("2222");
    expect(args).toContain("/keys/id_ed25519");
    expect(args).toContain("UserKnownHostsFile=/keys/known_hosts");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
  });

  test("scp uses -P for the port", () => {
    const args = scpArgs(ssh);
    expect(args[0]).toBe("-q");
    expect(args.slice(0, 2)).toEqual(["-q", "-P"]);
    expect(args[2]).toBe("2222");
  });

  test("remote targets are user@host:path", () => {
    expect(sshRemote(ssh, "/work/x")).toBe("agent@sandbox:/work/x");
  });

  test("script cds into the workspace and quotes it", () => {
    expect(sshScript("ls", "/work")).toBe("cd -- '/work' && ls");
    expect(sshScript("ls", "/wo'rk")).toBe("cd -- '/wo'\\''rk' && ls");
  });

  test("the bash -lc invocation is one quoted token", () => {
    expect(sshCommand(sshScript("pwd; id", "/work"))).toBe(
      "bash -lc 'cd -- '\\''/work'\\'' && pwd; id'",
    );
  });
});
