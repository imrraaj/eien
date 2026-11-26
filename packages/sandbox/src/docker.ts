import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { Result } from "better-result";
import type { CommandFailed } from "./errors.ts";
import { commandFailed } from "./errors.ts";
import { resolveInRoot } from "./paths.ts";
import { runCopy, runProcess, shellQuote } from "./process.ts";
import type { CopyOptions, DockerOptions, ExecOptions, ExecResult, Sandbox } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
/** Let the in-container `timeout` fire before the Docker CLI is killed. */
const EXEC_GRACE_MS = 15_000;
const DOCKER_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MS = 120_000;

/** `docker exec` argv for one fresh `bash -lc` inside the long-lived container. Exported for tests. */
export function dockerExecArgs(
    name: string,
    command: string,
    cwd: string,
    timeoutSec: number,
    stdin: boolean,
): string[] {
    return [
        "exec",
        ...(stdin ? ["-i"] : []),
        "-w",
        cwd,
        name,
        "timeout",
        "--signal=TERM",
        "--kill-after=5s",
        `${timeoutSec}s`,
        "bash",
        "-lc",
        command,
    ];
}

/** `docker run` argv for a small persistent Linux container. Exported for tests. */
export function dockerRunArgs(name: string, image: string, root: string, network: "bridge" | "none"): string[] {
    return [
        "run",
        "-d",
        "--name",
        name,
        "--init",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--shm-size",
        "1g",
        ...(network === "none" ? ["--network", "none"] : []),
        "-w",
        root,
        image,
        "sleep",
        "infinity",
    ];
}

export function dockerCopyInArgs(name: string, localPath: string, remotePath: string): string[] {
    return ["cp", localPath, `${name}:${remotePath}`];
}

export function dockerCopyOutArgs(name: string, remotePath: string, localPath: string): string[] {
    return ["cp", `${name}:${remotePath}`, localPath];
}

/**
 * Sandbox backed by a long-lived Docker container. The container keeps the
 * filesystem and background processes alive; every command is a fresh
 * `docker exec ... bash -lc`.
 */
export class DockerSandbox implements Sandbox {
    readonly driver = "docker";
    readonly name: string;
    readonly root: string;
    readonly options: DockerOptions;

    private ready = false;
    private starting?: Promise<void>;

    constructor(config: { name: string; root: string; docker: DockerOptions }) {
        this.name = config.name;
        this.root = config.root;
        this.options = config.docker;

        if (!this.root.startsWith("/")) throw new Error(`sandbox workspace root must be absolute: ${this.root}`);

        const probe = spawnSync("docker", ["--version"], { encoding: "utf8" });
        if (probe.error || probe.status !== 0) {
            throw new Error("docker is not installed or not runnable. Install Docker on the host.");
        }
    }

    private ensure(): Promise<void> {
        if (this.ready) return Promise.resolve();
        if (!this.starting) {
            this.starting = this.startContainer()
                .then(() => {
                    this.ready = true;
                })
                .finally(() => {
                    this.starting = undefined;
                });
        }
        return this.starting;
    }

    private async startContainer(): Promise<void> {
        const inspect = await runProcess("docker", ["inspect", "-f", "{{.State.Running}}", this.name], {
            timeoutMs: DOCKER_TIMEOUT_MS,
        });
        if (inspect.exitCode === 0) {
            if (inspect.output.trim() === "true") return;
            const started = await runProcess("docker", ["start", this.name], { timeoutMs: START_TIMEOUT_MS });
            if (started.exitCode !== 0) {
                throw new Error(`could not start Docker container ${this.name}: ${started.output.trim()}`);
            }
            return;
        }
        if (!/no such (object|container)/i.test(inspect.output)) {
            throw new Error(`could not inspect Docker container ${this.name}: ${inspect.output.trim()}`);
        }

        const run = await runProcess(
            "docker",
            dockerRunArgs(this.name, this.options.image, this.root, this.options.network),
            { timeoutMs: START_TIMEOUT_MS },
        );
        if (run.exitCode !== 0) {
            throw new Error(
                `could not start Docker container ${this.name} from ${this.options.image}: ${run.output.trim()}`,
            );
        }
    }

    async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1_000));
        return this.execOnce(command, options, timeoutSec, true);
    }

    private async execOnce(
        command: string,
        options: ExecOptions,
        timeoutSec: number,
        retry: boolean,
    ): Promise<ExecResult> {
        await this.ensure();
        const run = await runProcess(
            "docker",
            dockerExecArgs(this.name, command, options.cwd ?? this.root, timeoutSec, options.stdin !== undefined),
            {
                timeoutMs: timeoutSec * 1_000 + EXEC_GRACE_MS,
                signal: options.signal,
                stdin: options.stdin,
            },
        );

        // A container removed or stopped out-of-band is safe to replace: the
        // command did not run.
        if (
            retry &&
            run.exitCode !== 0 &&
            /Error response from daemon:.*(No such container|is not running)/i.test(run.output)
        ) {
            this.ready = false;
            await this.ensure();
            return this.execOnce(command, options, timeoutSec, false);
        }

        return {
            ...run,
            timedOut: run.timedOut || run.exitCode === 124 || run.exitCode === 137,
        };
    }

    async copyIn(
        localPath: string,
        remotePath: string,
        options: CopyOptions = {},
    ): Promise<Result<void, CommandFailed>> {
        const resolved = resolveInRoot(this.root, remotePath);
        if (resolved.isErr()) return Result.err(commandFailed(1, resolved.error.message, "invalid sandbox path"));

        await this.ensure();
        const parent = posix.dirname(resolved.value);
        const made = await this.exec(`mkdir -p -- ${shellQuote(parent)}`, { timeoutMs: 15_000 });
        if (made.exitCode !== 0) {
            return Result.err(commandFailed(made.exitCode, made.output, `could not create ${parent}`));
        }
        return runCopy("docker", dockerCopyInArgs(this.name, localPath, resolved.value), options);
    }

    async copyOut(
        remotePath: string,
        localPath: string,
        options: CopyOptions = {},
    ): Promise<Result<void, CommandFailed>> {
        const resolved = resolveInRoot(this.root, remotePath);
        if (resolved.isErr()) return Result.err(commandFailed(1, resolved.error.message, "invalid sandbox path"));

        await this.ensure();
        const temp = `/tmp/eien-out-${randomUUID()}`;
        try {
            // Dereference symlinks inside the container before handing the file
            // to `docker cp`, so the host never receives a link to a host path.
            const prepared = await this.exec(`cp -L -R -p -f -- ${shellQuote(resolved.value)} ${shellQuote(temp)}`, {
                timeoutMs: 60_000,
            });
            if (prepared.exitCode !== 0) {
                return Result.err(commandFailed(prepared.exitCode, prepared.output, `cannot read ${resolved.value}`));
            }
            await mkdir(dirname(localPath), { recursive: true });
            return await runCopy("docker", dockerCopyOutArgs(this.name, temp, localPath), options);
        } finally {
            await this.exec(`rm -rf -- ${shellQuote(temp)}`, { timeoutMs: 15_000 }).catch(() => undefined);
        }
    }
}
