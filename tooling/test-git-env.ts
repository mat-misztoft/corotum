/**
 * Keep `bun test` Git subprocesses non-interactive. Developer credential
 * helpers and SSH can otherwise block a parallel suite until the test timeout.
 */
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_ASKPASS = "echo";
process.env.GCM_INTERACTIVE = "never";
process.env.GIT_SSH_COMMAND =
  "ssh -o BatchMode=yes -o ConnectTimeout=1";
