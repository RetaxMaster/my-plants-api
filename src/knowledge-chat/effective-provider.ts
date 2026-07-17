import type { AgentProvider } from '@retaxmaster/agents-realtime-protocol';

// The provider a run will ACTUALLY launch on — mirrors KnowledgeChatService's own resolution (Spec 3 §3.2):
//  • create → the create provider;
//  • sealed session (providerSessionId set) → session.provider, request IGNORED;
//  • unsealed opening-turn retry → request ?? session.provider.
// The Codex gate must apply to THIS value, never the raw DTO field, or a resume of a sealed codex session
// with `provider` omitted (or a misleading `provider:'claude'`) would slip through the gate. Extracted so
// the gate and the run path share ONE implementation (reuse-not-fork).
export function resolveEffectiveProvider(args: {
  isCreate: boolean;
  sealed: boolean;
  sessionProvider?: AgentProvider;
  requestProvider?: AgentProvider;
}): AgentProvider {
  if (args.isCreate) return args.requestProvider!;
  if (args.sealed) return args.sessionProvider!;
  return args.requestProvider ?? args.sessionProvider!;
}
