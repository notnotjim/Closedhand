// Clear conversation history: conversations and their Context Notes go,
// Pinned Facts, schedules and connections stay. The one wipe behind the
// dashboard's Clear conversation history and /clear in any chat
// (lib/clear-command.js), so both delete the same. Vendored: the bot and the
// dashboard each keep a copy (scripts/check-vendored-identical.js).
//
// Conversations live in several places and all of them go: the thread rows,
// the legacy single-row table, the web chat's transcript, the turns archived
// from long threads, the Context Notes distilled from them, and the
// conversations of Closedhand's own email, here and in its relay on
// closedhand.com. `relay` is the call to that relay, which each service makes
// its own way. Context Notes are picked by item_type, so the wipe cannot
// touch the Pinned Facts that share the memory service.
function mustWrite(result) {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

async function clearConversations(db, userId, relay) {
  const account = mustWrite(await db.from("assistant_email_accounts").select("*").eq("user_id", userId).maybeSingle());
  if (account?.address) await relay(account, "clear", "POST", { remove: false, resume: true });
  mustWrite(await db.from("assistant_email_threads").delete().eq("user_id", userId));
  mustWrite(await db.from("conversation_threads").delete().eq("user_id", userId));
  mustWrite(await db.from("conversations").update({ messages: [], summary: null }).eq("user_id", userId));
  mustWrite(await db.from("web_messages").delete().eq("user_id", userId));
  mustWrite(await db.from("data_cache").delete().eq("user_id", userId).in("source", ["conversation", "assistant_email"]));
  mustWrite(await db.from("data_vectors").delete().eq("user_id", userId).eq("source_metadata->>source", "assistant_email"));
  mustWrite(await db.from("data_vectors").delete().eq("user_id", userId).eq("service", "memory")
    .in("item_type", ["conversation_summary", "thread_summary"]));
}

module.exports = { clearConversations };
