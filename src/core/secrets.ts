import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const PREFIX = 'enc:v1:';
const keys = new Map<string, Buffer>();

function secretKey(environment: NodeJS.ProcessEnv): Buffer | null {
  const secret = environment.DEV_LOG_SECRET_KEY?.trim();
  if (!secret) return null;
  if (secret.length < 16) throw new Error('DEV_LOG_SECRET_KEY muss mindestens 16 Zeichen lang sein.');
  let key = keys.get(secret);
  if (!key) {
    key = scryptSync(secret, 'dev-log/secrets', 32);
    keys.set(secret, key);
  }
  return key;
}

export const isEncrypted = (value: string): boolean => value.startsWith(PREFIX);

/** Encrypts with AES-256-GCM when DEV_LOG_SECRET_KEY is set; without a key the value stays as it is. */
export function encryptSecret(value: string, environment: NodeJS.ProcessEnv = process.env): string {
  const key = secretKey(environment);
  if (!key || isEncrypted(value)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

/** Reads values written by encryptSecret; plain values from before encryption are returned unchanged. */
export function decryptSecret(value: string, environment: NodeJS.ProcessEnv = process.env): string {
  if (!isEncrypted(value)) return value;
  const key = secretKey(environment);
  if (!key) throw new Error('Der Wert ist verschlüsselt, aber DEV_LOG_SECRET_KEY ist nicht gesetzt.');
  const data = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
