import { Result } from "better-result";
import { DeliveryFailed } from "./errors.ts";
import { scrubDashes } from "./style.ts";
import type { Address, OutboundMessage, OutputService } from "./types.ts";

/** Routes agent output to whichever service owns the address. Services come and go at runtime. */
export class OutputRouter {
  readonly #services = new Map<string, OutputService>();

  add(service: OutputService): void {
    if (this.#services.has(service.name)) throw new Error(`output "${service.name}" is already registered`);
    this.#services.set(service.name, service);
  }

  remove(name: string): void {
    this.#services.delete(name);
  }

  promptHint(service: string): string | undefined {
    return this.#services.get(service)?.promptHint;
  }

  send(to: Address, message: OutboundMessage): Promise<Result<void, DeliveryFailed>> {
    const service = this.#services.get(to.service);
    if (!service) {
      return Promise.resolve(
        Result.err(
          new DeliveryFailed({ service: to.service, reason: "no_service", message: `no output service "${to.service}"` }),
        ),
      );
    }
    return service.send(to.chat, styled(message));
  }
}

function styled(message: OutboundMessage): OutboundMessage {
  switch (message.kind) {
    case "text":
      return { ...message, text: scrubDashes(message.text) };
    case "file":
      return message.caption === undefined ? message : { ...message, caption: scrubDashes(message.caption) };
    case "status":
      return message;
  }
}
