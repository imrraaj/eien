import { SbxSandbox } from "./sbx.ts";
import { SshSandbox } from "./ssh.ts";
import type { Sandbox, SandboxConfig } from "./types.ts";

/** Build the sandbox backend the config asks for. */
export function createSandbox(config: SandboxConfig): Sandbox {
    switch (config.driver) {
        case "sbx":
            return new SbxSandbox(config);
        case "ssh":
            return new SshSandbox(config);
    }
}
