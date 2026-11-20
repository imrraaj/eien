/**
 * Sent once when a turn is still running after a minute. Shorter turns rely on
 * the typing indicator alone, so greetings never get an acknowledgement.
 */
export const ACK_TEXT = "Still working on it — I'll post the result here when it's done.";
