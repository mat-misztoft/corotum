const version = "0.1.0";

if (Bun.argv.includes("--version") || Bun.argv.includes("-v")) {
  console.log(`toolmirror ${version}`);
} else {
  console.log("ToolMirror CLI feasibility spike");
}
