export function umamiAssets(host?: string, websiteId?: string) {
  const origin = host?.trim().replace(/\/$/, "");
  const id = websiteId?.trim();
  if (!origin || !id) return null;
  return {
    script: `${origin}/script.js`,
    recorder: `${origin}/recorder.js`,
    websiteId: id,
  };
}
