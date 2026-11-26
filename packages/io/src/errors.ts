import { TaggedError } from "better-result";

/**
 * An output service could not deliver a message. `too_large` and `unsupported`
 * are the service's own limits; `failed` is the transport giving up; `no_service`
 * means nothing is registered for the address.
 */
export class DeliveryFailed extends TaggedError("DeliveryFailed")<{
    service: string;
    reason: "too_large" | "failed" | "no_service";
    message: string;
    cause?: unknown;
}> {}
