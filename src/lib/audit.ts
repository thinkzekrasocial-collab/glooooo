/** Audit logging, security events and notification fan-out (TRD §13 / §16). */
import { db } from "@/db";
import { auditLogs, notifications, securityEvents } from "@/db/schema";
import { uuid } from "@/lib/crypto";

export type AuditInput = {
  eventType: string;
  actorId: string;
  actorRole?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  action: string;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
  deviceId?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  result?: "success" | "failure" | "blocked";
  reason?: string | null;
};

/** Audit writes never contain message plaintext — metadata only. */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: uuid(),
      eventType: input.eventType,
      actorId: input.actorId,
      actorRole: input.actorRole ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      action: input.action,
      details: input.details ?? {},
      ipAddress: input.ipAddress ?? null,
      deviceId: input.deviceId ?? null,
      userAgent: input.userAgent ?? null,
      correlationId: input.correlationId ?? null,
      result: input.result ?? "success",
      reason: input.reason ?? null,
    });
  } catch (error) {
    console.error("[audit] failed to persist event", error);
  }
}

export type SecurityEventInput = {
  userId?: string | null;
  eventType: string;
  severity?: "info" | "warning" | "critical";
  ipAddress?: string | null;
  deviceId?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
};

export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  try {
    await db.insert(securityEvents).values({
      id: uuid(),
      userId: input.userId ?? null,
      eventType: input.eventType,
      severity: input.severity ?? "info",
      ipAddress: input.ipAddress ?? null,
      deviceId: input.deviceId ?? null,
      userAgent: input.userAgent ?? null,
      details: input.details ?? {},
    });
  } catch (error) {
    console.error("[security] failed to persist event", error);
  }
}

export type NotifyInput = {
  userId: string;
  type: "message" | "mention" | "security" | "invitation" | "system";
  title: string;
  body?: string | null;
  data?: Record<string, unknown>;
  channel?: "in_app" | "push" | "email";
};

export async function notifyUser(input: NotifyInput): Promise<void> {
  try {
    await db.insert(notifications).values({
      id: uuid(),
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      data: input.data ?? {},
      channel: input.channel ?? "in_app",
      status: "sent",
      sentAt: new Date(),
    });
  } catch (error) {
    console.error("[notify] failed", error);
  }
}
