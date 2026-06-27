const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const VAULT_KEY_PATH = path.join(__dirname, '..', 'secrets', 'vault-key.txt');

function ensureVaultKeyFile() {
  const secretsDir = path.dirname(VAULT_KEY_PATH);

  if (!fs.existsSync(secretsDir)) {
    fs.mkdirSync(secretsDir, { recursive: true });
  }

  if (!fs.existsSync(VAULT_KEY_PATH)) {
    const key = crypto.randomBytes(KEY_LENGTH);
    fs.writeFileSync(VAULT_KEY_PATH, key.toString('hex'), { mode: 0o600 });
  }
}

function loadVaultKey() {
  ensureVaultKeyFile();

  const raw = fs.readFileSync(VAULT_KEY_PATH, 'utf8').trim();
  const key = Buffer.from(raw, 'hex');

  if (key.length !== KEY_LENGTH) {
    throw new Error(`Vault key must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex characters)`);
  }

  return key;
}

function encryptPayload(data) {
  const key = loadVaultKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = JSON.stringify(data);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptPayload(encrypted) {
  const key = loadVaultKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(encrypted.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');

  return JSON.parse(plaintext);
}

module.exports = {
  VAULT_KEY_PATH,
  ensureVaultKeyFile,
  loadVaultKey,
  encryptPayload,
  decryptPayload,
};
