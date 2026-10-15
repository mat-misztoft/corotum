import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, win32 } from "node:path";

type Result = { code: number; stdout: string; stderr: string };
type Options = {
  platform?: NodeJS.Platform;
  home?: string;
  executable?: string;
  uid?: number;
  run?: (command: string, args: string[]) => Promise<Result>;
};
export type NativeAutoStatus = {
  installed: boolean;
  running: boolean;
  detail: string;
};

const runCommand = (command: string, args: string[]): Promise<Result> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") return reject(error);
        resolve({ code: (error?.code as number) || 0, stdout, stderr });
      },
    );
  });
const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c] ?? c,
  );
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** References the installed binary in place: upgrades atomically replace that path, not a copied service binary. */
export function createNativeAutoService(options: Options = {}) {
  const platform = options.platform ?? process.platform;
  if (!["darwin", "linux", "win32"].includes(platform))
    throw new Error(`Unsupported OS: ${platform}`);
  const home = options.home ?? homedir();
  const currentName = process.execPath
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase();
  const executable =
    options.executable ??
    process.env.COROTUM_EXECUTABLE ??
    (currentName === "corotum" || currentName === "corotum.exe"
      ? process.execPath
      : platform === "win32"
        ? join(
            process.env.LOCALAPPDATA || join(home, "AppData", "Local"),
            "ToolMirror",
            "bin",
            "corotum.exe",
          )
        : join(home, ".local/bin/corotum"));
  if (
    (!isAbsolute(executable) && !win32.isAbsolute(executable)) ||
    [...(executable + home)].some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  ) {
    throw new Error(
      "Service executable must be an absolute path without control characters",
    );
  }
  const run = options.run ?? runCommand;
  const label = "com.corotum.auto";
  const unit = "corotum-auto.service";
  const domain = `gui/${options.uid ?? process.getuid?.() ?? 0}`;
  const file =
    platform === "darwin"
      ? join(home, "Library/LaunchAgents", `${label}.plist`)
      : join(home, ".config/systemd/user", unit);
  async function command(name: string, args: string[]) {
    const result = await run(name, args);
    if (result.code !== 0)
      throw new Error(
        `${name} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    return result;
  }
  function powershell(script: string) {
    return command("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        `$ErrorActionPreference='Stop'; $task='Corotum Auto '+[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ${script}`,
        "utf16le",
      ).toString("base64"),
    ]);
  }
  async function status(): Promise<NativeAutoStatus> {
    if (platform === "win32") {
      const r = await powershell(
        `$t=Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue; if($t){$i=$t|Get-ScheduledTaskInfo; @{installed=$true;running=($t.State -eq 'Running');detail=("State="+$t.State+"; LastTaskResult="+$i.LastTaskResult)}|ConvertTo-Json -Compress}else{'{"installed":false,"running":false,"detail":"Not installed"}'}`,
      );
      return JSON.parse(r.stdout) as NativeAutoStatus;
    }
    let installed = true;
    try {
      await access(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      installed = false;
    }
    if (!installed)
      return { installed, running: false, detail: "Not installed" };
    const r =
      platform === "darwin"
        ? await run("launchctl", ["print", `${domain}/${label}`])
        : await run("systemctl", [
            "--user",
            "show",
            unit,
            "--property=ActiveState,SubState,Result,ExecMainStatus",
          ]);
    if (
      r.code &&
      !(platform === "darwin" && /Could not find service/i.test(r.stderr))
    )
      throw new Error(r.stderr || r.stdout || "Service status failed");
    return {
      installed,
      running:
        platform === "darwin"
          ? /state = running/.test(r.stdout)
          : /^ActiveState=active$/m.test(r.stdout),
      detail: (r.stderr || r.stdout).trim(),
    };
  }
  async function stop() {
    if (platform === "win32") {
      await powershell(
        `$t=Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue; if($t -and $t.State -eq 'Running'){$t|Stop-ScheduledTask}`,
      );
      return;
    }
    if (platform === "linux") {
      if ((await status()).installed)
        await command("systemctl", ["--user", "stop", unit]);
      return;
    }
    const r = await run("launchctl", ["bootout", `${domain}/${label}`]);
    if (r.code && !/Could not find service|No such process/i.test(r.stderr))
      throw new Error(r.stderr || "launchctl bootout failed");
  }
  async function start() {
    if (platform === "win32") {
      await powershell(
        `$t=Get-ScheduledTask -TaskName $task; if($t.State -ne 'Running'){Start-ScheduledTask -TaskName $task}`,
      );
      return;
    }
    if (platform === "linux") {
      await command("systemctl", ["--user", "start", unit]);
      return;
    }
    const r = await run("launchctl", ["print", `${domain}/${label}`]);
    if (r.code) await command("launchctl", ["bootstrap", domain, file]);
    else if (!/state = running/.test(r.stdout))
      await command("launchctl", ["kickstart", `${domain}/${label}`]);
  }
  async function install() {
    await access(executable);
    if (platform === "win32") {
      await powershell(
        `$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $a=New-ScheduledTaskAction -Execute ${ps(executable)} -Argument '--non-interactive auto run'; $t=New-ScheduledTaskTrigger -AtLogOn -User $u; $p=New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited; $s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; Register-ScheduledTask -TaskName $task -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null`,
      );
      return;
    }
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const quoted =
      '"' +
      executable.replace(/[%$\\"]/g, (c) =>
        c === "%" ? "%%" : c === "$" ? "$$" : `\\${c}`,
      ) +
      '"';
    const content =
      platform === "darwin"
        ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[executable, "--non-interactive", "auto", "run"].map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>ExitTimeOut</key><integer>0</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>\n`
        : `[Unit]\nDescription=Corotum automatic sync\n[Service]\nExecStart=${quoted} --non-interactive auto run\nRestart=always\nRestartSec=30\nTimeoutStopSec=infinity\nStandardOutput=null\nStandardError=null\n[Install]\nWantedBy=default.target\n`;
    // Zero/infinity lets the worker finish its current sync after SIGTERM.
    let existing: string | undefined;
    try {
      existing = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing === content) {
      if (platform === "linux")
        await command("systemctl", ["--user", "enable", unit]);
      return;
    }
    if (platform === "darwin") await stop();
    await writeFile(file, content, { mode: 0o600 });
    if (platform === "linux") {
      await command("systemctl", ["--user", "daemon-reload"]);
      await command("systemctl", ["--user", "enable", unit]);
    }
  }
  async function remove() {
    if (platform === "win32") {
      await stop();
      await powershell(
        `$t=Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue; if($t){$t|Unregister-ScheduledTask -Confirm:$false}`,
      );
      return;
    }
    if (!(await status()).installed) return;
    await stop();
    if (platform === "linux")
      await command("systemctl", ["--user", "disable", unit]);
    await rm(file, { force: true });
    if (platform === "linux")
      await command("systemctl", ["--user", "daemon-reload"]);
  }
  return { install, start, stop, remove, status };
}
