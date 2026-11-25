import { DockerSandbox } from "./docker.ts";
import { SbxSandbox } from "./sbx.ts";
import type { Sandbox, SandboxConfig } from "./types.ts";

/** Build the sandbox backend the config asks for. */
export function createSandbox(config: SandboxConfig): Sandbox {
    switch (config.driver) {
        case "docker":
            return new DockerSandbox(config);
        case "sbx":
            return new SbxSandbox(config);
    }
}
