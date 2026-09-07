export async function hashPassword(password) {
  return Bun.password.hash(String(password), {
    algorithm: "argon2id",
  });
}

export async function verifyPassword(password, passwordHash) {
  return Bun.password.verify(String(password), String(passwordHash));
}
