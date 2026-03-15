/**
 * AES-256-CBC encryption/decryption for Gmail OAuth tokens stored in DB.
 * Key is read from TOKEN_ENCRYPTION_KEY env var (64-char hex = 32 bytes).
 */
const crypto = require("crypto");

const ALGORITHM = "aes-256-cbc";
const IV_LENGTH = 16; // AES block size

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).");
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypts a plain-text string.
 * Returns "iv_hex:encrypted_hex" stored as a single string in the DB.
 */
function encrypt(plainText) {
  if (!plainText) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts a value previously produced by encrypt().
 * Returns the original plain-text string.
 *
 * Fallback: if the stored value is not in "iv:encrypted" format it was saved
 * before encryption was introduced (plain text). Return it as-is so existing
 * users are not broken before they re-login and get their tokens re-saved encrypted.
 */
function decrypt(cipherText) {
  if (!cipherText) return null;
  const colonIndex = cipherText.indexOf(":");
  // Encrypted format is always "32-char-iv-hex:data-hex"
  // Plain Google tokens (ya29.xxx, 1//xxx) never have a colon at position 32
  if (colonIndex !== 32) {
    // Legacy plain-text token — return as-is (will be re-encrypted on next saveTokens)
    return cipherText;
  }
  const ivHex = cipherText.slice(0, 32);
  const encryptedHex = cipherText.slice(33);
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

module.exports = { encrypt, decrypt };
