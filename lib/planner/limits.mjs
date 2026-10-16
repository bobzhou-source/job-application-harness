// Shared prompt/output limits for the planner modules (prompt bytes, goal/escalation text caps).

export const TIMEOUT_MS = 50_000;
export const MAX_PROMPT_BYTES = 96 * 1024;
export const MAX_STDOUT_BYTES = 64 * 1024;
export const MAX_STDERR_BYTES = 16 * 1024;
export const MAX_GOALS = 8;
export const MAX_GOAL_CHARS = 200;
export const MAX_GUIDANCE_CHARS = 800;
export const MAX_RECENT_LINES = 6;
export const MAX_RECENT_CHARS = 200;

export const MAX_FIELD_OPTIONS = 20;
export const MAX_OPTION_CHARS = 60;
export const MAX_FIELD_VALUE_CHARS = 120;
export const MAX_ANSWER_CHARS = 120;
export const MIN_ANSWER_BYTES = 8 * 1024;
