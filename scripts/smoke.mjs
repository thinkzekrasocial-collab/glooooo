/**
 * End-to-end smoke test for the GlobeBridge messenger API.
 * Run against a locally started production server: node scripts/smoke.mjs
 */
const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3000";

let failures = 0;
function check(label, condition, extra = "") {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${label} ${extra}`);
  }
}

async function api(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  const setCookie = response.headers.get("set-cookie");
  return { status: response.status, json, cookie: setCookie ? setCookie.split(";")[0] : null };
}

async function login(email, password) {
  const result = await api("/api/auth/login", { method: "POST", body: { email, password } });
  return result;
}

async function deviceKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveKey",
    "deriveBits",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return JSON.stringify(jwk);
}

const PASSWORD = "GlobeBridge#2026!";

async function main() {
  console.log("→ bootstrap");
  const setup = await api("/api/setup", { method: "POST" });
  check("POST /api/setup", setup.status === 200 && setup.json.ok === true, JSON.stringify(setup.json));

  const health = await api("/api/health");
  check("GET /api/health", health.status === 200 && health.json.ok, JSON.stringify(health.json));

  console.log("→ admin sign-in");
  const adminLogin = await login("admin@globebridge.edu", PASSWORD);
  check("admin login", adminLogin.status === 200 && adminLogin.cookie, JSON.stringify(adminLogin.json));
  const admin = adminLogin.cookie;

  const me = await api("/api/users/me", { cookie: admin });
  check("GET /api/users/me", me.status === 200 && me.json.user, JSON.stringify(me.json).slice(0, 200));

  console.log("→ admin console reads");
  for (const path of [
    "/api/admin/overview",
    "/api/admin/users",
    "/api/admin/groups",
    "/api/admin/audit",
    "/api/admin/security",
    "/api/admin/reports",
    "/api/admin/invitations",
    "/api/admin/settings",
  ]) {
    const result = await api(path, { cookie: admin });
    check(`GET ${path}`, result.status === 200, `${result.status} ${JSON.stringify(result.json).slice(0, 160)}`);
  }

  console.log("→ account provisioning (the only creation path)");
  const created = await api("/api/admin/users", {
    method: "POST",
    cookie: admin,
    body: {
      email: `smoke.${Date.now()}@globebridge.edu`,
      firstName: "Smoke",
      lastName: "Tester",
      userType: "student",
      status: "active",
    },
  });
  check(
    "POST /api/admin/users",
    created.status === 201 && created.json.user && created.json.temporaryPassword,
    JSON.stringify(created.json).slice(0, 200),
  );
  const createdId = created.json?.user?.id;

  const invite = await api("/api/admin/invitations", {
    method: "POST",
    cookie: admin,
    body: {
      email: `invite.${Date.now()}@globebridge.edu`,
      firstName: "Invited",
      lastName: "Person",
      userType: "student",
      expiresInDays: 7,
    },
  });
  check("POST /api/admin/invitations", invite.status === 201 && invite.json.onboardingUrl, JSON.stringify(invite.json).slice(0, 200));

  const publicSignup = await api("/api/admin/settings", {
    method: "PUT",
    cookie: admin,
    body: { settings: { "registration.public_signup_enabled": true } },
  });
  check("public signup cannot be enabled", publicSignup.status === 422, String(publicSignup.status));

  console.log("→ device key registration");
  const adminKeys = await api("/api/keys", {
    method: "POST",
    cookie: admin,
    body: { deviceName: "Smoke admin browser", publicIdentityKey: await deviceKey() },
  });
  check("POST /api/keys (admin)", adminKeys.status === 201 && adminKeys.json.deviceId, JSON.stringify(adminKeys.json));

  const groups = await api("/api/admin/groups", { cookie: admin });
  const advisory = groups.json.groups.find((group) => group.name === "Grade 11 Advisory");
  const groupCreate = await api("/api/admin/groups", {
    method: "POST",
    cookie: admin,
    body: { name: `Smoke Group ${Date.now()}`, groupType: "custom", status: "active" },
  });
  check("POST /api/admin/groups", groupCreate.status === 201, JSON.stringify(groupCreate.json).slice(0, 160));

  if (createdId && groupCreate.json?.group?.id) {
    const memberAdd = await api(`/api/admin/groups/${groupCreate.json.group.id}/members`, {
      method: "POST",
      cookie: admin,
      body: { userIds: [createdId], memberRole: "member" },
    });
    check("POST group members", memberAdd.status === 201, JSON.stringify(memberAdd.json).slice(0, 160));
  }

  console.log("→ messaging as the provisioned account");
  const student = await login("alina.rahman@globebridge.edu", PASSWORD);
  check("student login", student.status === 200 && student.cookie, JSON.stringify(student.json));
  const studentCookie = student.cookie;

  const studentKeys = await api("/api/keys", {
    method: "POST",
    cookie: studentCookie,
    body: { deviceName: "Smoke student browser", publicIdentityKey: await deviceKey() },
  });
  const studentDeviceId = studentKeys.json?.deviceId;
  check("POST /api/keys (student)", studentKeys.status === 201 && studentDeviceId, JSON.stringify(studentKeys.json));

  const adminConversations = await api("/api/conversations", { cookie: admin });
  check("GET /api/conversations (admin)", adminConversations.status === 200 && adminConversations.json.conversations.length > 0);
  const directConversation = adminConversations.json.conversations.find((c) => c.type === "direct");
  check("direct channel present", Boolean(directConversation), JSON.stringify(adminConversations.json).slice(0, 200));

  if (directConversation) {
    const conversationId = directConversation.id;
    const detail = await api(`/api/conversations/${conversationId}`, { cookie: admin });
    check("GET conversation detail", detail.status === 200 && detail.json.members.length >= 2, JSON.stringify(detail.json).slice(0, 160));

    const keys = await api(`/api/conversations/${conversationId}/keys`, { cookie: admin });
    check("GET conversation keys", keys.status === 200 && keys.json.myDeviceRegistered === true, JSON.stringify(keys.json).slice(0, 200));

    const adminDeviceId = keys.json.myDeviceId;
    const grants = [
      { deviceId: adminDeviceId, wrappedKey: "c21va2Utd3JhcA==", wrappedKeyIv: "MTIzNDU2Nzg5MDEy" },
      { deviceId: studentDeviceId, wrappedKey: "c21va2Utd3JhcA==", wrappedKeyIv: "MTIzNDU2Nzg5MDEy" },
    ];
    const grant = await api(`/api/conversations/${conversationId}/keys`, {
      method: "POST",
      cookie: admin,
      body: { grants },
    });
    check("POST conversation key grants", grant.status === 201 && grant.json.stored === 2, JSON.stringify(grant.json));

    const send = await api(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      cookie: admin,
      body: {
        clientMessageId: `smoke-${Date.now()}`,
        ciphertext: "c21va2UtY2lwaGVydGV4dA==",
        ciphertextIv: "MTIzNDU2Nzg5MDEy",
        contentType: "text",
      },
    });
    check("POST message (ciphertext only)", send.status === 201 && send.json.messageId, JSON.stringify(send.json));

    const duplicate = await api(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      cookie: admin,
      body: {
        clientMessageId: `dup-${Date.now()}`,
        ciphertext: "c21va2U=",
        ciphertextIv: "MTIzNDU2Nzg5MDEy",
      },
    });
    const duplicateAgain = await api(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      cookie: admin,
      body: {
        clientMessageId: duplicate.json.clientMessageId,
        ciphertext: "c21va2U=",
        ciphertextIv: "MTIzNDU2Nzg5MDEy",
      },
    });
    const dedupe = await api(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      cookie: admin,
      body: {
        clientMessageId: duplicate.json.clientMessageId,
        ciphertext: "c21va2U=",
        ciphertextIv: "MTIzNDU2Nzg5MDEy",
      },
    });
    check("idempotent send", dedupe.status === 200 && dedupe.json.deduplicated === true, JSON.stringify(dedupe.json));

    const studentFetch = await api(`/api/conversations/${conversationId}/messages?markRead=1`, {
      cookie: studentCookie,
    });
    check(
      "student fetches ciphertext page",
      studentFetch.status === 200 && studentFetch.json.messages.length >= 1,
      JSON.stringify(studentFetch.json).slice(0, 200),
    );

    const readAck = await api(`/api/conversations/${conversationId}/state`, {
      method: "POST",
      cookie: studentCookie,
      body: { action: "read" },
    });
    check("read receipt acknowledged", readAck.status === 200, JSON.stringify(readAck.json));

    const typing = await api(`/api/conversations/${conversationId}/state`, {
      method: "POST",
      cookie: studentCookie,
      body: { action: "typing" },
    });
    check("typing indicator", typing.status === 200, JSON.stringify(typing.json));

    const adminRefetch = await api(`/api/conversations/${conversationId}/messages`, { cookie: admin });
    const readCount = adminRefetch.json.messages.reduce((max, message) => Math.max(max, message.readCount), 0);
    const deliveredCount = adminRefetch.json.messages.reduce(
      (max, message) => Math.max(max, message.deliveredCount),
      0,
    );
    check("status advanced to read", readCount > 0 && deliveredCount > 0, `read=${readCount} delivered=${deliveredCount}`);

    const report = await api("/api/reports", {
      method: "POST",
      cookie: studentCookie,
      body: {
        targetType: "conversation",
        targetId: conversationId,
        reason: "Harassment or bullying",
        description: "Smoke test report",
        submittedContent: "voluntary excerpt",
      },
    });
    check("POST /api/reports", report.status === 201, JSON.stringify(report.json));

    const reportList = await api("/api/admin/reports?status=pending", { cookie: admin });
    const smokeReport = reportList.json.reports.find((row) => row.id === report.json.reportId);
    check("report visible to admin", Boolean(smokeReport));
    if (smokeReport) {
      const resolved = await api("/api/admin/reports", {
        method: "PATCH",
        cookie: admin,
        body: { id: smokeReport.id, status: "under_review", resolutionNotes: "Smoke review" },
      });
      check("resolve report", resolved.status === 200, JSON.stringify(resolved.json));
    }
  }

  console.log("→ messaging restrictions");
  const blocked = await api("/api/conversations", {
    method: "POST",
    cookie: studentCookie,
    body: { type: "group", groupId: advisory?.id ?? "missing" },
  });
  check("students cannot provision group channels", blocked.status === 403, String(blocked.status));

  const search = await api("/api/search?q=ali", { cookie: admin });
  check("GET /api/search", search.status === 200 && search.json.contentSearch === "client_side_only");

  const notifications = await api("/api/notifications", { cookie: admin });
  check("GET /api/notifications", notifications.status === 200 && Array.isArray(notifications.json.notifications));

  const preferences = await api("/api/users/me/preferences", {
    method: "PUT",
    cookie: studentCookie,
    body: { notifications: { pushEnabled: false }, privacy: { readReceipts: false } },
  });
  check("PUT /api/users/me/preferences", preferences.status === 200, JSON.stringify(preferences.json).slice(0, 160));

  const mfaEnroll = await api("/api/users/me/mfa", { method: "POST", cookie: studentCookie, body: { action: "enroll" } });
  check("POST MFA enrol", mfaEnroll.status === 200 && mfaEnroll.json.secret, JSON.stringify(mfaEnroll.json).slice(0, 120));

  const badLogin = await api("/api/auth/login", { method: "POST", body: { email: "admin@globebridge.edu", password: "wrong" } });
  check("bad password rejected", badLogin.status === 401 && badLogin.json.error.code === "AUTH_INVALID_CREDENTIALS", String(badLogin.status));

  const noSignup = await api("/api/auth/register", { method: "POST", body: {} });
  check("no registration route", noSignup.status === 404, String(noSignup.status));

  const anonymous = await api("/api/admin/users");
  check("admin API requires auth", anonymous.status === 401, String(anonymous.status));

  const logout = await api("/api/auth/logout", { method: "POST", cookie: admin, body: {} });
  check("POST /api/auth/logout", logout.status === 200, JSON.stringify(logout.json));

  console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("smoke test crashed", error);
  process.exit(1);
});
