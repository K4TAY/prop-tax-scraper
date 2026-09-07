import { SignJWT, jwtVerify } from "jose";

const DEFAULT_EXPIRY = "7d";

function getSecretKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret || !String(secret).trim()) {
    throw new Error("JWT_SECRET is not configured");
  }
  return new TextEncoder().encode(String(secret));
}

export async function signToken(user) {
  const key = getSecretKey();
  return new SignJWT({
    role: user.role,
    email: user.email,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime(DEFAULT_EXPIRY)
    .sign(key);
}

export async function verifyToken(token) {
  const key = getSecretKey();
  const { payload } = await jwtVerify(String(token), key, {
    algorithms: ["HS256"],
  });
  const sub = payload.sub;
  if (!sub) throw new Error("Invalid token: missing subject");
  return {
    userId: Number(sub),
    role: String(payload.role || "USER"),
    email: String(payload.email || ""),
  };
}
