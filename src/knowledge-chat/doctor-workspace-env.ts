// The env var the doctor engine injects per-run to hand the spawned CLI its session workspace. It is the
// SAME name the doctor repo's tools read (repos/my-plants-plant-doctor/scripts/lib/workspace.ts
// WORKSPACE_ENV) — kept as one shared constant on the API side so a rename can't silently desync. cwd stays
// on the doctor checkout (loads CLAUDE.md/.claude/.codex); the workspace arrives ONLY through this variable.
export const WORKSPACE_ENV = 'PLANT_DOCTOR_SESSION_WORKSPACE';
