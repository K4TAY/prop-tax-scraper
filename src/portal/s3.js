import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

function env(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

/** Resolve Railway / AWS S3-compatible bucket config. */
export function resolveS3Config() {
  const bucket = env("BUCKET", "AWS_BUCKET", "S3_BUCKET", "BCAD_BUCKET");
  const accessKeyId = env(
    "ACCESS_KEY_ID",
    "AWS_ACCESS_KEY_ID",
    "S3_ACCESS_KEY_ID",
    "BCAD_ACCESS_KEY_ID"
  );
  const secretAccessKey = env(
    "SECRET_ACCESS_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "S3_SECRET_ACCESS_KEY",
    "BCAD_SECRET_ACCESS_KEY"
  );
  const endpoint = env(
    "ENDPOINT",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT",
    "S3_ENDPOINT",
    "BCAD_ENDPOINT"
  );
  const region = env("REGION", "AWS_REGION", "S3_REGION", "BCAD_REGION") || "auto";
  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) return null;
  return { bucket, accessKeyId, secretAccessKey, endpoint, region };
}

export function createBcadBucketStore() {
  const cfg = resolveS3Config();
  if (!cfg) {
    throw new Error(
      "S3 bucket not configured. Set ENDPOINT, BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION"
    );
  }
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: false,
  });

  return {
    kind: "s3",
    bucket: cfg.bucket,
    async exists(key) {
      try {
        await client.send(
          new HeadObjectCommand({ Bucket: cfg.bucket, Key: key })
        );
        return true;
      } catch (e) {
        if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound") {
          return false;
        }
        if (String(e?.name || "").includes("NotFound")) return false;
        if (String(e?.message || "").includes("Not Found")) return false;
        throw e;
      }
    },
    async readText(key) {
      const out = await client.send(
        new GetObjectCommand({ Bucket: cfg.bucket, Key: key })
      );
      return await out.Body.transformToString("utf8");
    },
    async readBytes(key) {
      const out = await client.send(
        new GetObjectCommand({ Bucket: cfg.bucket, Key: key })
      );
      const bytes = await out.Body.transformToByteArray();
      return Buffer.from(bytes);
    },
  };
}
