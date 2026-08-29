export const MIN_CLOUD_CLI_VERSION = "0.1.0";
export const CLI_VERSION_HEADER = "x-toolmirror-cli-version";

function parseVersion(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

export function cliVersionFrom(request: Request) {
  return request.headers.get(CLI_VERSION_HEADER);
}

export function isCompatibleCliVersion(
  version: string | null,
  minVersion = MIN_CLOUD_CLI_VERSION,
) {
  const parsed = version ? parseVersion(version) : null;
  const minimum = parseVersion(minVersion);
  if (!parsed || !minimum) return false;
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] > minimum[index]) return true;
    if (parsed[index] < minimum[index]) return false;
  }
  return true;
}

export function incompatibleCliResponse() {
  return Response.json(
    {
      error: "CLI upgrade required",
      minVersion: MIN_CLOUD_CLI_VERSION,
    },
    { status: 426 },
  );
}
