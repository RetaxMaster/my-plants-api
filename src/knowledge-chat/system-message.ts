/**
 * Platform-authored notices handed to the agent BESIDE the owner's message (spec §3.1).
 *
 * These travel out of band as the package's `systemMessage` field — never concatenated into the prompt,
 * never inside argv. The package frames them in a structural `<agents-rt:system-message>` block whose
 * instruction block teaches the agent that the frame carries the host's authority, and escapes any
 * delimiter the owner typed by hand. That frame REPLACED the old `[system]` marker: the marker existed
 * only because these messages used to render as if the owner had typed them, which is no longer true.
 * Do not reintroduce it — the agent guides now describe the frame, not the prefix.
 *
 * The strings remain a WIRE CONTRACT pinned by `system-message.test.ts`. Rows written before this change
 * still carry the marker in `prompt`; reading them is `legacy-prompt-split.ts`'s job, and that file is the
 * only place the retired literal survives.
 */
export const SYSTEM_MESSAGE = {
  declined: 'The user declined your request.',
  notApproved: 'The user still has not approved the request.',
  failed: (reason: string) => `Your request could not be applied: ${reason}`,
} as const;
