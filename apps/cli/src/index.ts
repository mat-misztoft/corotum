import { runCli } from "./cli";

const exitCode = await runCli(Bun.argv.slice(2));
if (exitCode !== 0) process.exitCode = exitCode;
