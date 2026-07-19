/**
 * The single documented marker for a line NOT written by the human (spec 5.5.5).
 * System messages travel as ordinary prompts on the existing chat channel, so they
 * render as if the owner had typed them. That is an accepted limitation of the current
 * chat package, which is OUT OF SCOPE (workspace fence). When the package grows a real
 * message type, only the transport changes — these strings and this marker stay.
 */
export const SYSTEM_MARKER = '[system]';

export const SYSTEM_MESSAGE = {
  declined: `${SYSTEM_MARKER} The user declined your request.`,
  notApproved: `${SYSTEM_MARKER} The user still has not approved the request.`,
  failed: (reason: string) => `${SYSTEM_MARKER} Your request could not be applied: ${reason}`,
} as const;
