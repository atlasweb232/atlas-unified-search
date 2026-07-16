import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function createCredentialCipher(secret) {
  if (!secret) throw new Error('CONNECTOR_CREDENTIAL_ENCRYPTION_KEY or IDENTITY_JWT_SECRET is required');
  const key = createHash('sha256').update(String(secret)).digest();
  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
    },
    decrypt(value) {
      const [version, iv, tag, ciphertext] = String(value || '').split('.');
      if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Invalid encrypted credential payload');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8'));
    },
  };
}
