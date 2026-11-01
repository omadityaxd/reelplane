/**
 * Creates the storage bucket (if missing) and applies the CORS rules browser uploads need.
 * Works against any S3-compatible provider; locally it targets the RustFS container.
 */
import {
  createS3Client,
  ensureBucket,
  loadStorageConfig,
  PUBLIC_MEDIA_PREFIX,
} from "@reelplane/storage";
import { loadRootEnv } from "./load-env.ts";

loadRootEnv();

const config = loadStorageConfig();
const origins = (process.env.ALLOWED_UPLOAD_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

try {
  const { created, publicReadError } = await ensureBucket(
    createS3Client(config),
    config.bucket,
    origins,
  );
  process.stdout.write(
    `${created ? "Created" : "Found"} bucket "${config.bucket}" on ${config.provider} (${config.endpoint}); ` +
      `CORS allows ${origins.join(", ")}\n`,
  );
  process.stdout.write(
    publicReadError === null
      ? `Published media (${PUBLIC_MEDIA_PREFIX}*) is publicly readable.\n`
      : `Could not set a public-read policy (${publicReadError}).\n` +
          `Make ${PUBLIC_MEDIA_PREFIX}* public in your provider's console (B2: a public bucket; R2: a public bucket domain), ` +
          "or put a CDN in front and set STORAGE_PUBLIC_BASE_URL.\n",
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `Could not initialise bucket "${config.bucket}" at ${config.endpoint}: ${message}\n` +
      "Is the local stack running? Try `pnpm infra:up`.\n",
  );
  process.exitCode = 1;
}
