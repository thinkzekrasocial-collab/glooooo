/**
 * Browser-side end-to-end encryption (TRD §7).
 *
 * • Identity keys: ECDH P-256 generated with Web Crypto. The private key is
 *   created NON-extractable and stored as a structured-clone CryptoKey in
 *   IndexedDB — it can never be read out, only used, and never reaches the server.
 * • Message encryption: AES-256-GCM with a random 96-bit IV per message.
 * • Conversation keys: random 256-bit keys. A copy is wrapped per member device
 *   with ECDH(P-256) → HKDF-SHA256 → AES-256-GCM(wrap) and only the wrapped
 *   blobs are uploaded.
 * • Attachments: encrypted with the same conversation key before upload.
 *
 * The production build (TRD §3.2) replaces the message layer with libsignal
 * (X3DH + Double Ratchet) and the file layer with libsodium. The API contract
 * (ciphertext + IV + per-device wrapped keys) is identical.
 */

import { apiBaseUrl } from "@/lib/api-client";

const DB_NAME = "globebridge-e2ee";
const DB_VERSION = 1;
const IDENTITY_STORE = "identity";
const KEY_STORE = "conversationKeys";
const IDENTITY_KEY = "device-identity";

export class E2eeUnavailableError extends Error {}

export type JsonWebKeyLike = JsonWebKey;

export type DeviceIdentity = {
  deviceId: string;
  publicJwk: JsonWebKey;
  deviceName: string;
};

type StoredIdentity = {
  deviceId: string | null;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JsonWebKey;
  deviceName: string;
};

function subtle(): SubtleCrypto {
  if (typeof window === "undefined" || !window.crypto?.subtle) {
    throw new E2eeUnavailableError(
      "Web Crypto is unavailable. Use a secure (HTTPS or localhost) origin in a modern browser.",
    );
  }
  return window.crypto.subtle;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(IDENTITY_STORE)) database.createObjectStore(IDENTITY_STORE);
      if (!database.objectStoreNames.contains(KEY_STORE)) database.createObjectStore(KEY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
  });
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const database = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = database.transaction(store, "readonly");
    const request = tx.objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const database = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ─────────────────────────── helpers ─────────────────────────── */

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", input as unknown as BufferSource));
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function detectDeviceName(): string {
  const ua = typeof navigator === "undefined" ? "Browser" : navigator.userAgent;
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /Firefox\//.test(ua) ? "Firefox"
    : "Browser";
  const platform =
    typeof navigator === "undefined" ? "device" : navigator.platform || "device";
  return `${browser} on ${platform}`;
}

/* ─────────────────────────── identity ─────────────────────────── */

async function loadOrCreateIdentity(): Promise<StoredIdentity> {
  const existing = await idbGet<StoredIdentity>(IDENTITY_STORE, IDENTITY_KEY);
  if (existing?.privateKey && existing.publicJwk) return existing;

  const generateParams: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };
  const keyPair = await subtle().generateKey(generateParams, false, ["deriveKey", "deriveBits"]);
  const publicJwk = await subtle().exportKey("jwk", keyPair.publicKey);
  const record: StoredIdentity = {
    deviceId: null,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicJwk,
    deviceName: detectDeviceName(),
  };
  await idbPut(IDENTITY_STORE, IDENTITY_KEY, record);
  return record;
}

async function importPublicJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  const importParams: EcKeyImportParams = { name: "ECDH", namedCurve: "P-256" };
  return subtle().importKey("jwk", jwk, importParams, true, []);
}

/** Registers (or refreshes) this browser as a trusted device and returns its id. */
export async function ensureDeviceIdentity(): Promise<DeviceIdentity> {
  const identity = await loadOrCreateIdentity();

  const apiBase = apiBaseUrl();
  const response = await fetch(`${apiBase}/api/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      deviceName: identity.deviceName,
      browserInfo: typeof navigator === "undefined" ? null : navigator.userAgent.slice(0, 190),
      publicIdentityKey: JSON.stringify(identity.publicJwk),
      deviceId: identity.deviceId,
    }),
  });
  const payload = (await response.json()) as { deviceId?: string };
  const deviceId = payload.deviceId;
  if (!response.ok || !deviceId) {
    if (identity.deviceId) return { deviceId: identity.deviceId, publicJwk: identity.publicJwk, deviceName: identity.deviceName };
    throw new E2eeUnavailableError("This browser could not be registered for encrypted messaging.");
  }
  await idbPut(IDENTITY_STORE, IDENTITY_KEY, { ...identity, deviceId });
  return { deviceId, publicJwk: identity.publicJwk, deviceName: identity.deviceName };
}

export async function currentDeviceId(): Promise<string | null> {
  const identity = await idbGet<StoredIdentity>(IDENTITY_STORE, IDENTITY_KEY);
  return identity?.deviceId ?? null;
}

export async function resetLocalIdentity(): Promise<void> {
  const identity = await idbGet<StoredIdentity>(IDENTITY_STORE, IDENTITY_KEY);
  if (!identity) return;
  await idbPut(IDENTITY_STORE, IDENTITY_KEY, { ...identity, deviceId: null });
}

/* ─────────────────────────── conversation keys ─────────────────────────── */

export function newConversationKeyMaterial(): string {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return toBase64(bytes);
}

export async function cacheConversationKey(conversationId: string, materialB64: string): Promise<void> {
  await idbPut(KEY_STORE, conversationId, materialB64);
}

export async function getCachedConversationKey(conversationId: string): Promise<string | null> {
  return (await idbGet<string>(KEY_STORE, conversationId)) ?? null;
}

async function importConversationKey(materialB64: string): Promise<CryptoKey> {
  return subtle().importKey("raw", fromBase64(materialB64) as unknown as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function deriveWrappingKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  conversationId: string,
): Promise<CryptoKey> {
  const salt = await sha256Bytes(utf8(`globebridge-conv-wrap-v1|${conversationId}`));
  return subtle().deriveKey(
    {
      name: "ECDH",
      public: peerPublicKey,
    },
    privateKey,
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as unknown as BufferSource,
      info: utf8("globebridge conv-key v1") as unknown as BufferSource,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Wraps the conversation key for one recipient device (ECDH → HKDF → AES-GCM). */
export async function wrapConversationKey(params: {
  conversationId: string;
  materialB64: string;
  recipientPublicJwk: JsonWebKey;
}): Promise<{ wrappedKey: string; wrappedKeyIv: string }> {
  const identity = await loadOrCreateIdentity();
  const peerKey = await importPublicJwk(params.recipientPublicJwk);
  const wrappingKey = await deriveWrappingKey(identity.privateKey, peerKey, params.conversationId);
  const iv = new Uint8Array(12);
  window.crypto.getRandomValues(iv);
  const wrapped = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    wrappingKey,
    fromBase64(params.materialB64) as unknown as BufferSource,
  );
  return { wrappedKey: toBase64(new Uint8Array(wrapped)), wrappedKeyIv: toBase64(iv) };
}

/** Unwraps a conversation key that was wrapped for this device. */
export async function unwrapConversationKey(params: {
  conversationId: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  senderPublicJwk: JsonWebKey;
}): Promise<string> {
  const identity = await loadOrCreateIdentity();
  const peerKey = await importPublicJwk(params.senderPublicJwk);
  const wrappingKey = await deriveWrappingKey(identity.privateKey, peerKey, params.conversationId);
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: fromBase64(params.wrappedKeyIv) as unknown as BufferSource },
    wrappingKey,
    fromBase64(params.wrappedKey) as unknown as BufferSource,
  );
  const materialB64 = toBase64(new Uint8Array(plain));
  await cacheConversationKey(params.conversationId, materialB64);
  return materialB64;
}

/* ─────────────────────────── payload crypto ─────────────────────────── */

export async function encryptText(
  conversationId: string,
  plaintext: string,
): Promise<{ ciphertext: string; ciphertextIv: string }> {
  const material = await getCachedConversationKey(conversationId);
  if (!material) throw new E2eeUnavailableError("No conversation key available on this device yet.");
  const key = await importConversationKey(material);
  const iv = new Uint8Array(12);
  window.crypto.getRandomValues(iv);
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    utf8(plaintext) as unknown as BufferSource,
  );
  return { ciphertext: toBase64(new Uint8Array(ciphertext)), ciphertextIv: toBase64(iv) };
}

export async function decryptText(
  conversationId: string,
  ciphertextB64: string,
  ivB64: string,
): Promise<string> {
  const material = await getCachedConversationKey(conversationId);
  if (!material) throw new E2eeUnavailableError("Waiting for the conversation key before decrypting.");
  const key = await importConversationKey(material);
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: fromBase64(ivB64) as unknown as BufferSource },
    key,
    fromBase64(ciphertextB64) as unknown as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

export async function encryptFile(conversationId: string, bytes: Uint8Array): Promise<string> {
  const material = await getCachedConversationKey(conversationId);
  if (!material) throw new E2eeUnavailableError("No conversation key available on this device yet.");
  const key = await importConversationKey(material);
  const iv = new Uint8Array(12);
  window.crypto.getRandomValues(iv);
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    bytes as unknown as BufferSource,
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return toBase64(combined);
}

export async function decryptFile(conversationId: string, payloadB64: string): Promise<Uint8Array> {
  const material = await getCachedConversationKey(conversationId);
  if (!material) throw new E2eeUnavailableError("No conversation key available on this device yet.");
  const key = await importConversationKey(material);
  const combined = fromBase64(payloadB64);
  const iv = combined.slice(0, 12);
  const body = combined.slice(12);
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    body as unknown as BufferSource,
  );
  return new Uint8Array(plain);
}
