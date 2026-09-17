/**
 * GET/POST /api/conversations/:id/keys — E2EE key distribution.
 *
 * The client generates a random AES-256-GCM conversation key, wraps a copy per
 * member device with ECDH(P-256)+HKDF, and uploads only the wrapped blobs.
 * The server stores opaque ciphertext it cannot unwrap (TRD §7).
 *
 * Self-healing distribution: the GET response lists member devices that do not
 * yet hold a wrapped key, so any client that already holds the key can grant it
 * (e.g. a member signing in on a new browser).
 */
import { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversationKeyWraps } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { isConversationMember, rawRows } from "@/lib/data";
import { ApiError, enforceRateLimit, jsonOk, readJson, route } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

type MemberDevice = {
  device_id: string;
  user_id: string;
  device_name: string;
  public_key: string;
  has_key: boolean;
};

export const GET = route(async (_req: NextRequest, meta, ctx: Ctx) => {
  const session = await requireUser();
  const { id } = await ctx.params;
  if (!(await isConversationMember(session.id, id))) {
    throw new ApiError("AUTH_FORBIDDEN", "You are not a member of this conversation.", 403);
  }

  const devices = await rawRows<MemberDevice>(sql`
    select d.id as device_id, d.user_id, d.device_name, d.public_identity_key as public_key,
      exists (
        select 1 from conversation_key_wraps k
        where k.conversation_id = ${id} and k.recipient_device_id = d.id
      ) as has_key
    from devices d
    where d.status = 'active'
      and exists (
        select 1 from conversation_members cm
        where cm.conversation_id = ${id} and cm.user_id = d.user_id and cm.left_at is null
      )
    order by d.created_at
  `);

  const mine = session.deviceId ? devices.find((d) => d.device_id === session.deviceId) : undefined;
  const myWrap = session.deviceId
    ? await db
        .select()
        .from(conversationKeyWraps)
        .where(
          and(
            eq(conversationKeyWraps.conversationId, id),
            eq(conversationKeyWraps.recipientDeviceId, session.deviceId),
          ),
        )
        .limit(1)
    : [];

  return jsonOk(
    {
      myDeviceId: session.deviceId,
      myDeviceRegistered: Boolean(mine),
      haveKey: myWrap.length > 0,
      myWrap: myWrap[0]
        ? {
            wrappedKey: myWrap[0].wrappedKey,
            wrappedKeyIv: myWrap[0].wrappedKeyIv,
            senderDeviceId: myWrap[0].senderDeviceId,
            wrapVersion: myWrap[0].wrapVersion,
          }
        : null,
      memberDevices: devices.map((d) => ({
        deviceId: d.device_id,
        userId: d.user_id,
        deviceName: d.device_name,
        publicKey: d.public_key,
        hasKey: Boolean(d.has_key),
      })),
      /** Devices awaiting a wrapped key — including this device. */
      pendingDevices: devices
        .filter((d) => !d.has_key)
        .map((d) => ({ deviceId: d.device_id, userId: d.user_id, publicKey: d.public_key })),
    },
    meta,
  );
});

export const POST = route(async (req: NextRequest, meta, ctx: Ctx) => {
  const session = await requireUser();
  const { id } = await ctx.params;
  enforceRateLimit(`key-grant:${session.id}`, 40, 60_000);

  if (!(await isConversationMember(session.id, id))) {
    throw new ApiError("AUTH_FORBIDDEN", "You are not a member of this conversation.", 403);
  }
  if (!session.deviceId) {
    throw new ApiError("DEVICE_REQUIRED", "Register this browser as a device before distributing keys.", 409);
  }

  const body = await readJson(req);
  const rawGrants = body.grants;
  if (!Array.isArray(rawGrants) || rawGrants.length === 0) {
    throw new ApiError("VALIDATION_REQUIRED", "grants must contain at least one wrapped key.", 422);
  }
  if (rawGrants.length > 50) {
    throw new ApiError("VALIDATION_RANGE", "Too many grants in one request.", 422);
  }

  const devices = await rawRows<{ device_id: string; user_id: string; has_key: boolean }>(sql`
    select d.id as device_id, d.user_id,
      exists (
        select 1 from conversation_key_wraps k
        where k.conversation_id = ${id} and k.recipient_device_id = d.id
      ) as has_key
    from devices d
    where d.status = 'active'
      and exists (
        select 1 from conversation_members cm
        where cm.conversation_id = ${id} and cm.user_id = d.user_id and cm.left_at is null
      )
  `);
  const deviceMap = new Map(devices.map((d) => [d.device_id, d]));

  const callerHasKey = devices.find((d) => d.device_id === session.deviceId)?.has_key === true;
  const bootstrapSelfWrap = rawGrants.some(
    (grant) =>
      typeof grant === "object" &&
      grant !== null &&
      (grant as { deviceId?: string }).deviceId === session.deviceId,
  );

  if (!callerHasKey && !bootstrapSelfWrap) {
    throw new ApiError(
      "KEY_NOT_HELD",
      "This device does not hold the conversation key yet and cannot distribute it.",
      403,
    );
  }

  const values: Array<{
    conversationId: string;
    recipientDeviceId: string;
    recipientUserId: string;
    senderDeviceId: string;
    wrappedKey: string;
    wrappedKeyIv: string;
  }> = [];

  for (const grant of rawGrants) {
    if (typeof grant !== "object" || grant === null) {
      throw new ApiError("VALIDATION_TYPE", "Each grant must be an object.", 422);
    }
    const record = grant as Record<string, unknown>;
    const deviceId = typeof record.deviceId === "string" ? record.deviceId : "";
    const wrappedKey = typeof record.wrappedKey === "string" ? record.wrappedKey : "";
    const wrappedKeyIv = typeof record.wrappedKeyIv === "string" ? record.wrappedKeyIv : "";
    const target = deviceMap.get(deviceId);
    if (!target) {
      throw new ApiError("KEY_TARGET_INVALID", "Grant targets a device outside this conversation.", 422, {
        deviceId,
      });
    }
    if (!wrappedKey || !wrappedKeyIv || wrappedKey.length > 2000) {
      throw new ApiError("VALIDATION_TYPE", "Wrapped key material is required for each grant.", 422);
    }
    values.push({
      conversationId: id,
      recipientDeviceId: deviceId,
      recipientUserId: target.user_id,
      senderDeviceId: session.deviceId!,
      wrappedKey,
      wrappedKeyIv,
    });
  }

  await db.insert(conversationKeyWraps).values(values).onConflictDoNothing();

  await recordAudit({
    eventType: "encryption.keys_distributed",
    actorId: session.id,
    actorRole: session.roles.join(","),
    action: "create",
    targetType: "conversation",
    targetId: id,
    details: {
      grants: values.length,
      algorithm: "ECDH-P256+HKDF-SHA256+AES-256-GCM",
      bootstrap: !callerHasKey,
    },
    ipAddress: meta.ip,
    deviceId: session.deviceId,
    correlationId: meta.requestId,
  });

  return jsonOk({ stored: values.length }, meta, 201);
});
