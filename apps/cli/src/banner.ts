export const COROTUM_BANNER = [
  ",-----.                       ,--.                     ",
  "'  .--./ ,---. ,--.--. ,---. ,-'  '-.,--.,--.,--,--,--. ",
  "|  |    | .-. ||  .--'| .-. |'-.  .-'|  ||  ||        | ",
  "'  '--'\\' '-' '|  |   ' '-' '  |  |  '  ''  '|  |  |  | ",
  " `-----' `---' `--'    `---'   `--'   `----' `--`--`--' ",
] as const;

/** Right-aligns `v<version>` under the ASCII wordmark. */
export function formatCorotumBanner(version: string): string {
  const width = Math.max(...COROTUM_BANNER.map((line) => line.length));
  return `${COROTUM_BANNER.join("\n")}\n${`v${version}`.padStart(width)}\n`;
}
