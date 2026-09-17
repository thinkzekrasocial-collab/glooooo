/**
 * GET/POST /api/keys
 *
 * Registers a browser device's *public* identity key (ECDH P-256, generated
 * non-extractable in the client — see src/lib/e2ee.ts). The private key never
 * leaves the device, so the server can route and store keys but can never
 * decrypt a message or a file (TRD §1.5, §7).
 */
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { devices, encryptionKeys, sessions } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { uuid } from "@/lib/crypto";
import { ApiError, enforceRateLimit, jsonOk, readJson, route, str } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, meta) => {
  const session = await requireUser();
  const rows = await db
    .select({
      id: devices.id,
      deviceName: devices.deviceName,
      browserInfo: devices.browserInfo,
      status: devices.status,
      createdAt: devices.createdAt,
      lastActiveAt: devices.lastActiveAt,
      publicIdentityKey: devices.publicIdentityKey,
    })
    .from(devices)
    .where(eq(devices.userId, session.id))
    .orderBy(devices.createdAt);

  return jsonOk(
    {
      currentDeviceId: session.deviceId,
      devices: rows.map((row) => ({
        ...row,
        current: row.id === session.deviceId,
        createdAt: row.createdAt.toISOString(),
        lastActiveAt: row.lastActiveAt ? row.lastActiveAt.toISOString() : null,
      })),
    },
    meta,
  );
});

export const POST = route(async (req: NextRequest, meta) => {
  const session = await requireUser();
  enforceRateLimit(`keys:${session.id}`, 30, 60_000);
  const body = await readJson(req);

  const deviceIdInput = str(body, "deviceId", { max: 64 });
  const deviceName = str(body, "deviceName", { required: true, max: 80, label: "Device name" })!;
  const browserInfo = str(body, "browserInfo", { max: 200 });
  const publicIdentityKey = str(body, "publicIdentityKey", { required: true, max: 4000, label: "Public key" })!;
  const publicSignedKey = str(body, "publicSignedKey", { max: 4000 });
  const pushSubscription = body.pushSubscription ?? null;

  let parsedKey: Record<string, unknown>;
  try {
    parsedKey = JSON.parse(publicIdentityKey) as Record<string, unknown>;
  } catch {
    throw new ApiError("VALIDATION_KEY_FORMAT", "Public key must be a JWK object.", 422);
  }
  if (parsedKey.kty !== "EC" || parsedKey.crv !== "P-256") {
    throw new ApiError("VALIDATION_KEY_ALGORITHM", "Only ECDH P-256 identity keys are accepted.", 422);
  }

  let deviceId = deviceIdInput;
  if (deviceId) {
    const existing = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, session.id)))
      .limit(1);
    if (existing.length === 0) deviceId = undefined;
  }

  if (deviceId) {
    await db
      .update(devices)
      .set({
        deviceName,
        browserInfo: browserInfo ?? null,
        publicIdentityKey,
        publicSignedKey: publicSignedKey ?? publicIdentityKey,
        pushSubscription,
        status: "active",
        verifiedAt: new Date(),
        lastActiveAt: new Date(),
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      })
      .where(eq(devices.id, deviceId));
    await db.delete(encryptionKeys).where(eq(encryptionKeys.deviceId, deviceId));
  } else {
    deviceId = uuid();
    await db.insert(devices).values({
      id: deviceId,
      userId: session.id,
      deviceName,
      deviceType: "web",
      browserInfo: browserInfo ?? null,
      publicIdentityKey,
      publicSignedKey: publicSignedKey ?? publicIdentityKey,
      pushSubscription,
      status: "active",
      verifiedAt: new Date(),
      lastActiveAt: new Date(),
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  await db.insert(encryptionKeys).values({
    id: uuid(),
    userId: session.id,
    deviceId,
    keyType: "identity",
    publicKey: publicIdentityKey,
    keyId: 1,
  });

  await db.update(sessions).set({ deviceId }).where(eq(sessions.id, session.sessionId));

  await recordAudit({
    eventType: "device.key_registered",
    actorId: session.id,
    action: "create",
    targetType: "device",
    targetId: deviceId,
    details: { deviceName, algorithm: "ECDH-P256" },
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
    deviceId,
    correlationId: meta.requestId,
  });

  return jsonOk({ deviceId, keyAlgorithm: "ECDH-P256", stored: "public-key-only" }, meta, 201);
});
