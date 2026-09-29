// Prints the relay's secrets as JSON, for `wrangler secret bulk`.
import { generateKeyPairSync, randomBytes } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
console.log(JSON.stringify({
  JWT_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }),
  JWT_PUBLIC_KEYS: JSON.stringify({ k1: publicKey.export({ format: "pem", type: "spki" }) }),
  IP_HASH_SALT: randomBytes(32).toString("hex"),
}));
