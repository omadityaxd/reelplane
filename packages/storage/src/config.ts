import { z } from "zod";

/** Local RustFS defaults from docker-compose.yml, used when no provider is configured. */
export const LOCAL_STORAGE_DEFAULTS = {
  STORAGE_PROVIDER: "local",
  STORAGE_ENDPOINT: "http://localhost:9000",
  STORAGE_REGION: "us-east-1",
  STORAGE_BUCKET: "reelplane",
  STORAGE_ACCESS_KEY_ID: "reelplane",
  STORAGE_SECRET_ACCESS_KEY: "reelplane-dev-secret",
  STORAGE_FORCE_PATH_STYLE: "true",
} as const;

const booleanString = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const storageEnvSchema = z.object({
  STORAGE_PROVIDER: z.enum(["local", "b2", "r2", "s3"]),
  STORAGE_ENDPOINT: z.url(),
  STORAGE_REGION: z.string().min(1),
  STORAGE_BUCKET: z.string().min(3).max(63),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  STORAGE_FORCE_PATH_STYLE: booleanString.optional(),
  /** Optional CDN / public bucket base URL for published HLS assets. */
  STORAGE_PUBLIC_BASE_URL: z.url().optional(),
});

const STORAGE_KEYS = storageEnvSchema.keyof().options;

export type StorageProvider = z.infer<typeof storageEnvSchema>["STORAGE_PROVIDER"];

export interface StorageConfig {
  provider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  publicBaseUrl: string;
}

type Env = Record<string, string | undefined>;

/**
 * Reads storage config from the environment. With no STORAGE_* variables set at all,
 * falls back to the local RustFS container so the project runs before any account exists.
 */
export function loadStorageConfig(env: Env = process.env): StorageConfig {
  // STORAGE_PUBLIC_BASE_URL alone keeps the local defaults: it only changes how playback URLs
  // are built (e.g. a LAN address so a phone can reach the laptop's storage).
  const hasProviderConfig = STORAGE_KEYS.some(
    (key) => key !== "STORAGE_PUBLIC_BASE_URL" && env[key],
  );
  const source: Env = hasProviderConfig
    ? env
    : { ...LOCAL_STORAGE_DEFAULTS, STORAGE_PUBLIC_BASE_URL: env.STORAGE_PUBLIC_BASE_URL };
  const cleaned = Object.fromEntries(
    STORAGE_KEYS.filter((key) => source[key]).map((key) => [key, source[key]]),
  );

  const parsed = storageEnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid storage configuration: ${issues}`);
  }

  const value = parsed.data;
  // Path-style is required by RustFS/MinIO; virtual-host style is the norm elsewhere.
  const forcePathStyle = value.STORAGE_FORCE_PATH_STYLE ?? value.STORAGE_PROVIDER === "local";
  const endpoint = value.STORAGE_ENDPOINT.replace(/\/+$/, "");

  return {
    provider: value.STORAGE_PROVIDER,
    endpoint,
    region: value.STORAGE_REGION,
    bucket: value.STORAGE_BUCKET,
    accessKeyId: value.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: value.STORAGE_SECRET_ACCESS_KEY,
    forcePathStyle,
    publicBaseUrl: (
      value.STORAGE_PUBLIC_BASE_URL ??
      defaultPublicBaseUrl(endpoint, value.STORAGE_BUCKET, forcePathStyle)
    ).replace(/\/+$/, ""),
  };
}

function defaultPublicBaseUrl(endpoint: string, bucket: string, forcePathStyle: boolean): string {
  if (forcePathStyle) return `${endpoint}/${bucket}`;
  const url = new URL(endpoint);
  return `${url.protocol}//${bucket}.${url.host}`;
}
