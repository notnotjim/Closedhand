// lib/tool-result-content.js — what a tool's answer becomes for the LLM, the
// same in chat, background tasks, routines and Pulse.
//
// A picture a tool opened (view_attachment and the like) goes to the LLM as
// the picture, with its description and what to look for beside it. The LLM
// client passes it to an LLM that reads pictures and puts a description in
// its place for one that does not (lib/llm.js, routeImages). Handing over the
// description alone left background work blind: a task looking for a receipt
// among the person's own screenshots read only "a phone screen that says
// Thank you for your purchase" and decided the receipt existed only as the
// text of an email.

// The content of a tool_result for a picture or a file read as text, or null
// for any other answer, which the caller formats its own way.
function toolResultContent(result) {
  if (result?._contentType === "image") {
    return [
      { type: "image", source: { type: "base64", media_type: result.mediaType, data: result.base64 } },
      { type: "text", text: `Image: ${result.description}` },
      ...(result.question ? [{ type: "text", text: `Look for: ${result.question}` }] : []),
      ...(result.sign_in_needed ? [{ type: "text", text: JSON.stringify({ sign_in_needed: result.sign_in_needed, sign_in_site: result.sign_in_site || "" }) }] : []),
    ];
  }
  if (result?._contentType === "text") return `File: ${result.fileName}\n\n${result.textContent}`;
  return null;
}

// What is kept of a run's messages in the database: a picture is kept as a
// note that one was shown, never its bytes, which would otherwise be written
// again on every step.
const NOTE = { type: "text", text: "[a picture was shown here]" };
function storable(messages) {
  if (!Array.isArray(messages)) return messages;
  const strip = (b) => (b?.type === "image" ? NOTE : b?.type === "tool_result" && Array.isArray(b.content) ? { ...b, content: b.content.map((c) => (c?.type === "image" ? NOTE : c)) } : b);
  return messages.map((m) => (Array.isArray(m?.content) ? { ...m, content: m.content.map(strip) } : m));
}

module.exports = { toolResultContent, storable };
