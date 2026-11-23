import type { InboundSink, InputService } from "./types.ts";

/** Starts input services against one sink. Services come and go at runtime. */
export class InputHub {
    readonly #services = new Map<string, InputService>();

    constructor(private readonly sink: InboundSink) {}

    async add(service: InputService): Promise<void> {
        if (this.#services.has(service.name)) throw new Error(`input "${service.name}" is already registered`);
        this.#services.set(service.name, service);
        try {
            await service.start(this.sink);
        } catch (error) {
            this.#services.delete(service.name);
            throw error;
        }
    }

    async remove(name: string): Promise<void> {
        const service = this.#services.get(name);
        if (!service) return;
        this.#services.delete(name);
        await service.stop();
    }

    async stopAll(): Promise<void> {
        await Promise.allSettled([...this.#services.keys()].map((name) => this.remove(name)));
    }
}
