/**
 * GET /api/search?q= — metadata search.
 *
 * Message bodies are end-to-end encrypted, so the server cannot index them.
 * This endpoint searches what the server is allowed to know: channel titles,
 * member names, the directory and group names. Plaintext message search happens
 * client-side over the decrypted in-memory cache (TRD §15).
 */
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { getDirectory, listConversationsForUser, myGroups } from "@/lib/data";
import { jsonOk, route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, meta) => {
  const session = await requireUser();
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? "").trim();

  if (query.length < 2) {
    return jsonOk(
      {
        query,
        contentSearch: "client_side_only",
        note: "Type at least two characters. Message bodies are E2EE and never server-searchable.",
        conversations: [],
        people: [],
        groups: [],
      },
      meta,
    );
  }

  const needle = query.toLowerCase();
  const [conversations, people, groups] = await Promise.all([
    listConversationsForUser(session.id, session.deviceId),
    getDirectory(session, query, 25),
    myGroups(session.id),
  ]);

  return jsonOk(
    {
      query,
      contentSearch: "client_side_only",
      note: "Server-side search covers metadata only — message text is decrypted in your browser.",
      conversations: conversations
        .filter(
          (c) =>
            (c.title ?? "").toLowerCase().includes(needle) ||
            c.members.some((m) => m.name.toLowerCase().includes(needle)),
        )
        .slice(0, 15)
        .map((c) => ({ id: c.id, title: c.title, type: c.type, lastMessageAt: c.lastMessageAt })),
      people: people.map((p) => ({ id: p.id, name: p.name, userType: p.userType, email: p.email })),
      groups: groups.filter((g) => g.name.toLowerCase().includes(needle)),
    },
    meta,
  );
});
