import { env } from "cloudflare:workers";
import { r2ArtifactBucket } from "../../../../../../src/artifacts";
import {
  handleGetWorkspaceArtifact,
  handlePutWorkspaceArtifact,
} from "../../../../../../src/artifacts-http";
import type { AuthEnvironment } from "../../../../../../src/auth";
import { isHostedCloud } from "../../../../../../src/billing";
import type { TokenDatabase } from "../../../../../../src/tokens";

const workerEnv = env as unknown as AuthEnvironment & { ARTIFACTS: R2Bucket };

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handleGetWorkspaceArtifact(
    request,
    workerEnv.DB as unknown as TokenDatabase,
    r2ArtifactBucket(workerEnv.ARTIFACTS),
    id,
    isHostedCloud(workerEnv),
  );
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return handlePutWorkspaceArtifact(
    request,
    workerEnv.DB as unknown as TokenDatabase,
    r2ArtifactBucket(workerEnv.ARTIFACTS),
    id,
    isHostedCloud(workerEnv),
  );
}
