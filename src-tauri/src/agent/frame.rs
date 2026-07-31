//! Pure protocol layer for the duplex `claude` stream-json wire format.
//!
//! Nothing in this file spawns a process, locks a mutex, or emits a Tauri
//! event — every public item is a plain struct or a pure function, which is
//! what makes the parser/encoder tests below runnable with no `claude` binary
//! and no process at all. `agent/mod.rs` is the only caller.

use serde_json::Value;

// ---------------------------------------------------------------------------
// Frame classification
// ---------------------------------------------------------------------------

/// Routing hint for one stream-json frame. `raw` on [`AgentFrame`] is always
/// the authoritative payload — `kind` only tells the UI branch which renderer
/// to reach for, so a brand-new Claude Code frame subtype is never dropped:
/// it just falls back to [`AgentFrameKind::Unknown`] with `raw` intact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentFrameKind {
    Init,
    Delta,
    Assistant,
    User,
    ToolUse,
    ToolResult,
    /// Spelled `Result_` in Rust — `Result` (unlike `result`) is not a
    /// keyword, but it does shadow `std::result::Result` as a bare
    /// identifier inside this module, so the wire's `"result"` string is
    /// restored explicitly via `rename` instead of relying on the
    /// `rename_all = "snake_case"` conversion (which would produce
    /// `"result_"`, not `"result"`).
    #[serde(rename = "result")]
    Result_,
    Permission,
    Control,
    System,
    Unknown,
    Stderr,
    Error,
    Exit,
}

/// Classify one parsed stream-json object. Every lookup goes through
/// `.get(...).and_then(...)` — never indexing — so a frame shaped nothing
/// like what CLI 2.1.220 emits today still classifies instead of panicking;
/// an unrecognised `type` (or none at all) returns [`AgentFrameKind::Unknown`].
///
/// Classification keys **only** off the top level: `type`, and for
/// `assistant` / `user` frames, the `type` of each block in
/// `message.content`; for `control_request`, `request.subtype`. This is
/// deliberate — `--include-partial-messages`'s `stream_event.event` shape was
/// never empirically reproduced (it needs a successful API call), so nothing
/// here depends on it.
pub fn classify(value: &Value) -> AgentFrameKind {
    let Some(frame_type) = value.get("type").and_then(Value::as_str) else {
        return AgentFrameKind::Unknown;
    };

    match frame_type {
        "system" => {
            if value.get("subtype").and_then(Value::as_str) == Some("init") {
                AgentFrameKind::Init
            } else {
                AgentFrameKind::System
            }
        }
        "stream_event" => AgentFrameKind::Delta,
        "assistant" => {
            if has_content_block(value, "tool_use") {
                AgentFrameKind::ToolUse
            } else {
                AgentFrameKind::Assistant
            }
        }
        "user" => {
            if has_content_block(value, "tool_result") {
                AgentFrameKind::ToolResult
            } else {
                AgentFrameKind::User
            }
        }
        "result" => AgentFrameKind::Result_,
        "control_request" => {
            let is_permission = value
                .get("request")
                .and_then(|r| r.get("subtype"))
                .and_then(Value::as_str)
                == Some("can_use_tool");
            if is_permission {
                AgentFrameKind::Permission
            } else {
                AgentFrameKind::Control
            }
        }
        "control_response" => AgentFrameKind::Control,
        _ => AgentFrameKind::Unknown,
    }
}

/// `true` if `value.message.content` is an array containing a block whose
/// `type` equals `block_type`. Every step tolerates a missing key or a
/// content field that isn't an array (a malformed or future frame shape),
/// returning `false` rather than panicking.
fn has_content_block(value: &Value, block_type: &str) -> bool {
    value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .is_some_and(|blocks| {
            blocks
                .iter()
                .any(|block| block.get("type").and_then(Value::as_str) == Some(block_type))
        })
}

// ---------------------------------------------------------------------------
// AgentFrame — the envelope emitted to the frontend
// ---------------------------------------------------------------------------

/// One `agent_frame:{pane_id}` event payload. `raw` carries the entire parsed
/// frame (or a synthetic object for the four non-wire kinds below) verbatim,
/// so the UI branch that consumes this never needs a Rust change to read a
/// new Claude Code field.
///
/// Serialize-only, snake_case, **no** `rename_all` — matches
/// `PtyExitedPayload` (`pty/mod.rs:55-59`), read as `exit_code` at
/// `frontend/src/lib/ipc.ts:230-233`. See Design decision 12 in the plan.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentFrame {
    pub pane_id: String,
    pub session_id: String,
    pub kind: AgentFrameKind,
    pub raw: Value,
}

/// `stderr` / `parse_error` text is user-controlled (whatever `claude` or the
/// child it spawned printed) and unbounded in principle — cap it so a
/// pathological line can't inflate an event payload without limit.
/// `String::truncate` would panic if the cut point lands inside a multi-byte
/// character, so truncation goes through `.chars().take(N)` instead, the same
/// idiom `scheduler/mod.rs:948` uses for the transcript summary.
pub const MAX_TEXT_CHARS: usize = 4000;

fn truncate_text(text: &str) -> String {
    text.chars().take(MAX_TEXT_CHARS).collect()
}

impl AgentFrame {
    /// A frame straight off stdout that parsed as JSON.
    pub fn parsed(pane_id: impl Into<String>, session_id: impl Into<String>, value: Value) -> Self {
        let kind = classify(&value);
        Self {
            pane_id: pane_id.into(),
            session_id: session_id.into(),
            kind,
            raw: value,
        }
    }

    /// One stderr line, surfaced as a frame rather than silently discarded
    /// (the explicit divergence from `scheduler/mod.rs:497-513`, which writes
    /// stderr to a transcript file the user never sees).
    pub fn stderr(pane_id: impl Into<String>, session_id: impl Into<String>, text: &str) -> Self {
        Self {
            pane_id: pane_id.into(),
            session_id: session_id.into(),
            kind: AgentFrameKind::Stderr,
            raw: serde_json::json!({ "source": "stderr", "text": truncate_text(text) }),
        }
    }

    /// A stdout line that failed to parse as JSON, or an over-long line the
    /// assembler had to drop. Never silently discarded — `text` carries what
    /// was salvageable (empty for an overflow, since the buffer was already
    /// cleared) and `err` carries why.
    pub fn parse_error(
        pane_id: impl Into<String>,
        session_id: impl Into<String>,
        text: &str,
        err: &str,
    ) -> Self {
        Self {
            pane_id: pane_id.into(),
            session_id: session_id.into(),
            kind: AgentFrameKind::Error,
            raw: serde_json::json!({
                "source": "stdout",
                "text": truncate_text(text),
                "error": err,
            }),
        }
    }

    /// The terminal frame for a pane's session — always last, emitted only
    /// after both reader threads have been joined (`agent/mod.rs`'s waiter
    /// thread), mirroring the ordering discipline at `scheduler/mod.rs:609-610`.
    pub fn exit(pane_id: impl Into<String>, session_id: impl Into<String>, exit_code: Option<i32>) -> Self {
        Self {
            pane_id: pane_id.into(),
            session_id: session_id.into(),
            kind: AgentFrameKind::Exit,
            raw: serde_json::json!({ "exit_code": exit_code }),
        }
    }
}

// ---------------------------------------------------------------------------
// LineAssembler — turns a byte stream into complete stream-json lines
// ---------------------------------------------------------------------------

/// A `Read tool_result` of a large file is legitimately megabytes, so the cap
/// is generous; it exists only to bound memory against a pathological line
/// that never terminates, not to reject realistic output.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// One assembled unit handed back by [`LineAssembler::push`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineOut {
    /// A complete, non-empty line (trailing `\r`, if any, already stripped).
    Line(String),
    /// The buffer exceeded [`MAX_FRAME_BYTES`] with no `\n` in sight. The
    /// carried value is the number of bytes dropped.
    Overflow(usize),
}

/// Splits a raw byte stream (fed a chunk at a time straight from a `Read`
/// loop) into complete stream-json lines.
///
/// Deliberately **not** `BufReader::lines()`, for three reasons: a single
/// invalid UTF-8 byte makes `lines()` yield `Err` with no clean resync; it has
/// no maximum line length, so a pathological line is an unbounded-memory
/// failure; and the split-line behaviour this module is required to test
/// would live inside `std`, where this repo cannot assert on it. Bytes are
/// buffered raw and decoded only once a complete line exists, so a multi-byte
/// UTF-8 character split across two `read()`s reassembles correctly instead
/// of being mangled by a per-chunk `from_utf8_lossy`.
pub struct LineAssembler {
    buf: Vec<u8>,
    /// `true` while resyncing after an overflow: bytes are discarded (without
    /// ever being decoded or emitted) until the next `\n` is found.
    overflowed: bool,
}

impl Default for LineAssembler {
    fn default() -> Self {
        Self::new()
    }
}

impl LineAssembler {
    pub fn new() -> Self {
        Self {
            buf: Vec::new(),
            overflowed: false,
        }
    }

    /// Feed the next chunk of bytes (one `Read::read` result). Returns zero
    /// or more [`LineOut`]s completed by this push; a partial line at the end
    /// of `bytes` is buffered for the next call.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<LineOut> {
        let mut out = Vec::new();
        self.buf.extend_from_slice(bytes);

        while let Some(newline_pos) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=newline_pos).collect();
            line.pop(); // drop the '\n' itself
            if line.last() == Some(&b'\r') {
                line.pop();
            }

            if self.overflowed {
                // This segment is the tail of the dropped over-long line —
                // it was never buffered in full, so it can't be decoded into
                // anything meaningful. Discard it and resume normal parsing.
                self.overflowed = false;
                continue;
            }

            let decoded = String::from_utf8_lossy(&line).into_owned();
            if decoded.trim().is_empty() {
                continue;
            }
            out.push(LineOut::Line(decoded));
        }

        if !self.overflowed && self.buf.len() > MAX_FRAME_BYTES {
            let dropped = self.buf.len();
            self.buf.clear();
            self.overflowed = true;
            out.push(LineOut::Overflow(dropped));
        }

        out
    }
}

// ---------------------------------------------------------------------------
// Outgoing message encoders
// ---------------------------------------------------------------------------

/// Encode one user turn as the exact stream-json shape CLI 2.1.220 accepted
/// on stdin, plus a single trailing `\n`.
///
/// `serde_json::to_string` escapes any newline in `text` as `\n` inside the
/// JSON string — it never emits a literal line break — which is the property
/// that keeps the CLI alive: a literal newline (or any malformed line) mid
/// stdin is fatal to `claude --input-format stream-json` (verified: it exits
/// 1 with `Error parsing streaming input line`).
pub fn encode_user_message(text: &str) -> Result<String, String> {
    let value = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": text }],
        },
    });
    encode_line(&value)
}

/// Encode a `control_request` asking `claude` to interrupt the current turn.
/// Verified against CLI 2.1.220: it responds with a `control_response`
/// carrying the same `request_id` and leaves the session alive for the next
/// turn — interrupt is not stop.
pub fn encode_interrupt(request_id: &str) -> Result<String, String> {
    let value = serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "interrupt" },
    });
    encode_line(&value)
}

/// Encode a `control_request` switching the model for the *live* session —
/// the wire equivalent of typing `/model` in the TUI, so a pane can change
/// model without losing its conversation.
///
/// Verified against CLI 2.1.220 by round-tripping a two-turn session: the CLI
/// answers `{"type":"control_response","response":{"subtype":"success",
/// "request_id":"<id>"}}`, the next assistant message carries the new
/// `message.model`, and the final `result.modelUsage` records both models. The
/// same subtype list also documents the failure modes we must not produce
/// (`set_model: model must be a string`, `invalid_model_type`), which is why
/// `model` is a plain `&str` here and validated non-empty by the caller.
pub fn encode_set_model(request_id: &str, model: &str) -> Result<String, String> {
    let value = serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "set_model", "model": model },
    });
    encode_line(&value)
}

/// Encode a `control_request` switching the permission mode of the *live*
/// session — the wire equivalent of Shift+Tab in the TUI, which a `--print`
/// child has no way to receive.
///
/// Verified against CLI 2.1.220 by round-tripping each mode through a child
/// spawned with exactly [`super::build_agent_argv`]'s flags. The mode is
/// engine-local: the response arrives with no model turn in between, so this
/// costs nothing. Success echoes the *applied* mode, which is not always the
/// requested one — `manual` is an alias the CLI normalises to `default`:
///
/// ```jsonc
/// // → {"type":"control_request","request_id":"…","request":{"subtype":"set_permission_mode","mode":"manual"}}
/// // ← {"type":"control_response","response":{"subtype":"success","request_id":"…","response":{"mode":"default"}}}
/// ```
///
/// Two verified failure modes, both `{"subtype":"error","error":"…"}`:
/// `bypassPermissions` is refused outright ("because the session was not
/// launched with --dangerously-skip-permissions" — it is spawn-time only, and
/// no live request can reach it), and an unrecognised mode answers "Cannot set
/// permission mode: must be one of acceptEdits, auto, bypassPermissions,
/// default, dontAsk, plan". That list is the CLI's canonical set; the caller
/// validates against [`super::PERMISSION_MODES`], which is the `--help` flag
/// spelling of the same set (`manual` where the canonical list says `default`)
/// and is accepted here because the CLI aliases it before validating.
pub fn encode_set_permission_mode(request_id: &str, mode: &str) -> Result<String, String> {
    let value = serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "set_permission_mode", "mode": mode },
    });
    encode_line(&value)
}

/// Encode a `control_response` answering a `can_use_tool` permission request.
/// Both variants below were round-tripped against CLI 2.1.220 (the plan's
/// Wire verification, runs B and C):
///
/// ```jsonc
/// // allow
/// {"type":"control_response","response":{"subtype":"success","request_id":"<id>",
///  "response":{"behavior":"allow","updatedInput":{…echo of request.input…}}}}
/// // deny
/// {"type":"control_response","response":{"subtype":"success","request_id":"<id>",
///  "response":{"behavior":"deny","message":"Denied in Codenest"}}}
/// ```
///
/// `updated_input` is `None` → `{}` (an allow with no echoed input drives the
/// CLI's "falling back to original tool input" warning path — deliberately
/// never our default, see the caller). `message` is `None` on a deny →
/// `"Denied in Codenest"`. `updatedPermissions` is never emitted: the
/// captured `permission_suggestions` carry `"destination":"localSettings"`,
/// i.e. echoing them back would write a persistent rule into the user's
/// settings file — the opposite of "allow for this session" (Design
/// decision 7 in the plan).
pub fn encode_permission_response(
    request_id: &str,
    allow: bool,
    updated_input: Option<&Value>,
    message: Option<&str>,
) -> Result<String, String> {
    let response = if allow {
        serde_json::json!({
            "behavior": "allow",
            "updatedInput": updated_input.cloned().unwrap_or_else(|| serde_json::json!({})),
        })
    } else {
        serde_json::json!({
            "behavior": "deny",
            "message": message.unwrap_or("Denied in Codenest"),
        })
    };
    let value = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response,
        },
    });
    encode_line(&value)
}

fn encode_line(value: &Value) -> Result<String, String> {
    let mut line = serde_json::to_string(value).map_err(|e| format!("encode stdin line: {e}"))?;
    line.push('\n');
    Ok(line)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Value {
        serde_json::from_str(json).expect("test fixture must be valid JSON")
    }

    // -- classify: system / init -------------------------------------------

    #[test]
    fn classify_tags_system_init_and_other_system_subtypes() {
        let init = parse(
            r#"{"type":"system","subtype":"init","cwd":"/tmp","session_id":"s1",
               "tools":[],"model":"claude","permissionMode":"dontAsk","slash_commands":[]}"#,
        );
        assert_eq!(classify(&init), AgentFrameKind::Init);

        let status = parse(
            r#"{"type":"system","subtype":"status","status":"requesting","uuid":"u1","session_id":"s1"}"#,
        );
        assert_eq!(classify(&status), AgentFrameKind::System);

        let hook = parse(r#"{"type":"system","subtype":"hook_started"}"#);
        assert_eq!(classify(&hook), AgentFrameKind::System);
    }

    #[test]
    fn classify_tags_assistant_text_frame() {
        let frame = parse(
            r#"{"type":"assistant","message":{"role":"assistant",
               "content":[{"type":"text","text":"hi"}],"usage":{}},
               "parent_tool_use_id":null,"session_id":"s1","uuid":"u1"}"#,
        );
        assert_eq!(classify(&frame), AgentFrameKind::Assistant);
    }

    #[test]
    fn classify_tags_result_frame() {
        let success = parse(
            r#"{"type":"result","subtype":"success","is_error":false,"result":"done",
               "usage":{},"total_cost_usd":0.01,"session_id":"s1"}"#,
        );
        assert_eq!(classify(&success), AgentFrameKind::Result_);

        // is_error:true is still a `result` frame — error-ness is the UI's
        // read of `raw`, not a separate kind.
        let failure = parse(
            r#"{"type":"result","subtype":"success","is_error":true,
               "result":"Invalid API key · Fix external API key","usage":{},
               "total_cost_usd":0,"api_error_status":401,"session_id":"s1"}"#,
        );
        assert_eq!(classify(&failure), AgentFrameKind::Result_);
    }

    #[test]
    fn classify_detects_tool_use_content_block() {
        let frame = parse(
            r#"{"type":"assistant","message":{"role":"assistant","content":[
                 {"type":"text","text":"Let me check"},
                 {"type":"tool_use","id":"t1","name":"Read","input":{}}
               ]},"session_id":"s1"}"#,
        );
        assert_eq!(classify(&frame), AgentFrameKind::ToolUse);
        // raw still carries every block — nothing is dropped for a mixed turn.
        assert_eq!(
            frame["message"]["content"].as_array().map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn classify_detects_tool_result_content_block() {
        let tool_result = parse(
            r#"{"type":"user","message":{"role":"user","content":[
                 {"type":"tool_result","tool_use_id":"t1","content":"ok"}
               ]},"session_id":"s1"}"#,
        );
        assert_eq!(classify(&tool_result), AgentFrameKind::ToolResult);

        let plain_user = parse(
            r#"{"type":"user","message":{"role":"user",
               "content":[{"type":"text","text":"hello"}]},"session_id":"s1"}"#,
        );
        assert_eq!(classify(&plain_user), AgentFrameKind::User);
    }

    #[test]
    fn classify_tags_stream_event_as_delta() {
        // The inner `event` shape was never empirically reproduced — this
        // must classify from the top-level `type` alone.
        let frame = parse(r#"{"type":"stream_event","event":{"whatever":"unreproduced"}}"#);
        assert_eq!(classify(&frame), AgentFrameKind::Delta);
    }

    #[test]
    fn classify_separates_permission_from_other_control() {
        let permission = parse(
            r#"{"type":"control_request","request_id":"req_1",
               "request":{"subtype":"can_use_tool","tool_name":"Bash"}}"#,
        );
        assert_eq!(classify(&permission), AgentFrameKind::Permission);

        // The verified interrupt ack — no `session_id` key at all.
        let ack = parse(
            r#"{"type":"control_response","response":{"subtype":"success",
               "request_id":"req_1","response":{"still_queued":[]}}}"#,
        );
        assert!(ack.get("session_id").is_none());
        assert_eq!(classify(&ack), AgentFrameKind::Control);
    }

    #[test]
    fn classify_unknown_type_is_not_dropped() {
        assert_eq!(
            classify(&parse(r#"{"type":"brand_new_2027_frame"}"#)),
            AgentFrameKind::Unknown
        );
        assert_eq!(classify(&parse(r#"{"no_type":1}"#)), AgentFrameKind::Unknown);
    }

    #[test]
    fn classify_never_panics_on_malformed_shapes() {
        assert_eq!(
            classify(&parse(r#"{"type":"assistant","message":{"content":"not-an-array"}}"#)),
            AgentFrameKind::Assistant
        );
        assert_eq!(
            classify(&parse(r#"{"type":"assistant","message":{"content":null}}"#)),
            AgentFrameKind::Assistant
        );
        assert_eq!(
            classify(&parse(r#"{"type":"assistant"}"#)),
            AgentFrameKind::Assistant
        );
        assert_eq!(
            classify(&parse(r#"{"type":"control_request","request_id":"r1"}"#)),
            AgentFrameKind::Control
        );
    }

    // -- LineAssembler -------------------------------------------------------

    #[test]
    fn line_assembler_splits_on_newline() {
        let mut assembler = LineAssembler::new();
        let out = assembler.push(b"{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(
            out,
            vec![
                LineOut::Line("{\"a\":1}".to_string()),
                LineOut::Line("{\"b\":2}".to_string()),
            ]
        );
        assert!(assembler.push(b"").is_empty());
    }

    #[test]
    fn line_assembler_joins_a_line_split_across_two_reads() {
        let mut assembler = LineAssembler::new();
        assert!(assembler.push(b"{\"type\":\"resu").is_empty());
        let out = assembler.push(b"lt\"}\n");
        assert_eq!(out.len(), 1);
        let LineOut::Line(line) = &out[0] else {
            panic!("expected a Line, got {out:?}");
        };
        let value: Value = serde_json::from_str(line).expect("reassembled line must parse");
        assert_eq!(classify(&value), AgentFrameKind::Result_);
    }

    #[test]
    fn line_assembler_handles_a_frame_split_at_a_multibyte_char() {
        // U+1F600 (an emoji) encodes as the 4 bytes F0 9F 98 80. Split the
        // read exactly inside that sequence — after its first two bytes — to
        // prove the assembler buffers raw bytes and decodes only once a
        // whole line exists, rather than lossily decoding each read() chunk
        // on its own (which would corrupt the character at the split point).
        let mut first = b"{\"text\":\"hi".to_vec();
        first.extend_from_slice(&[0xF0, 0x9F]);
        let mut second: Vec<u8> = vec![0x98, 0x80];
        second.extend_from_slice(b"\"}\n");

        let mut assembler = LineAssembler::new();
        assert!(assembler.push(&first).is_empty());
        let out = assembler.push(&second);
        assert_eq!(out.len(), 1);
        let LineOut::Line(got) = &out[0] else {
            panic!("expected a Line, got {out:?}");
        };
        assert_eq!(got, "{\"text\":\"hi\u{1F600}\"}");
    }

    #[test]
    fn line_assembler_strips_trailing_cr_and_skips_blank_lines() {
        let mut assembler = LineAssembler::new();
        let out = assembler.push(b"{\"a\":1}\r\n\n");
        assert_eq!(out, vec![LineOut::Line("{\"a\":1}".to_string())]);
    }

    #[test]
    fn line_assembler_reports_and_resyncs_after_overflow() {
        let mut assembler = LineAssembler::new();
        let huge = vec![b'x'; MAX_FRAME_BYTES + 1];
        let out = assembler.push(&huge);
        assert_eq!(out.len(), 1);
        match &out[0] {
            LineOut::Overflow(n) => assert_eq!(*n, MAX_FRAME_BYTES + 1),
            other => panic!("expected Overflow, got {other:?}"),
        }

        // The dangling remainder of the dropped line is still unterminated —
        // its closing newline must resync silently, not surface as a Line.
        let out = assembler.push(b"\n");
        assert!(out.is_empty(), "the resync newline must not surface as a line");

        // The next complete line after resync is emitted normally.
        let out = assembler.push(b"{\"type\":\"result\"}\n");
        assert_eq!(
            out,
            vec![LineOut::Line("{\"type\":\"result\"}".to_string())]
        );
    }

    // -- Encoders --------------------------------------------------------

    #[test]
    fn encode_user_message_is_exactly_one_line() {
        let text = "line one\nline two\twith tab \"quote\" \\backslash \u{1F600}";
        let encoded = encode_user_message(text).expect("encode should succeed");

        assert_eq!(encoded.matches('\n').count(), 1);
        assert!(encoded.ends_with('\n'));

        let value: Value =
            serde_json::from_str(encoded.trim_end()).expect("must be valid single-line JSON");
        assert_eq!(value["message"]["content"][0]["text"].as_str(), Some(text));
    }

    #[test]
    fn encode_user_message_shape_matches_the_verified_wire_format() {
        let encoded = encode_user_message("hi").expect("encode should succeed");
        let value: Value = serde_json::from_str(encoded.trim_end()).expect("must parse");
        assert_eq!(value["type"], "user");
        assert_eq!(value["message"]["role"], "user");
        assert_eq!(value["message"]["content"][0]["type"], "text");
    }

    #[test]
    fn encode_permission_response_allow_matches_the_captured_control_response() {
        let input = serde_json::json!({"command": "curl -s https://example.com/nope"});
        let encoded = encode_permission_response("req_1", true, Some(&input), None)
            .expect("encode should succeed");

        assert_eq!(encoded.matches('\n').count(), 1);
        assert!(encoded.ends_with('\n'));

        let value: Value = serde_json::from_str(encoded.trim_end()).expect("must parse");
        let expected = serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "req_1",
                "response": {
                    "behavior": "allow",
                    "updatedInput": input,
                },
            },
        });
        assert_eq!(value, expected);
    }

    #[test]
    fn encode_permission_response_allow_with_no_input_echoes_an_empty_object() {
        let encoded =
            encode_permission_response("req_2", true, None, None).expect("encode should succeed");
        let value: Value = serde_json::from_str(encoded.trim_end()).expect("must parse");
        assert_eq!(value["response"]["response"]["updatedInput"], serde_json::json!({}));
    }

    #[test]
    fn encode_permission_response_deny_carries_a_message() {
        let encoded = encode_permission_response("req_3", false, None, None)
            .expect("encode should succeed");
        let value: Value = serde_json::from_str(encoded.trim_end()).expect("must parse");
        assert_eq!(value["response"]["response"]["behavior"], "deny");
        assert_eq!(value["response"]["response"]["message"], "Denied in Codenest");

        let custom = encode_permission_response("req_4", false, None, Some("nope"))
            .expect("encode should succeed");
        let custom_value: Value = serde_json::from_str(custom.trim_end()).expect("must parse");
        assert_eq!(custom_value["response"]["response"]["message"], "nope");
    }

    #[test]
    fn encode_user_message_line_is_byte_exact() {
        // Pinned so the composer's `previewUserMessageLine` TS test cannot
        // silently drift from the wire: `serde_json` here has no
        // `preserve_order` feature, so keys serialise alphabetically.
        let encoded = encode_user_message("hi").expect("encode should succeed");
        assert_eq!(
            encoded,
            "{\"message\":{\"content\":[{\"text\":\"hi\",\"type\":\"text\"}],\"role\":\"user\"},\"type\":\"user\"}\n"
        );
    }

    #[test]
    fn encode_interrupt_matches_the_verified_control_request() {
        let encoded = encode_interrupt("req_1").expect("encode should succeed");
        assert_eq!(encoded.matches('\n').count(), 1);
        assert!(encoded.ends_with('\n'));

        let value: Value = serde_json::from_str(encoded.trim_end()).expect("must parse");
        let expected = serde_json::json!({
            "type": "control_request",
            "request_id": "req_1",
            "request": { "subtype": "interrupt" },
        });
        assert_eq!(value, expected);
    }

    /// Pins the shape that was round-tripped against CLI 2.1.220 — a live
    /// model switch is a `control_request`, so it must be exactly one line
    /// like every other stdin write (a literal newline mid-stdin is fatal to
    /// `--input-format stream-json`).
    #[test]
    fn encode_set_model_matches_the_verified_control_request() {
        let encoded = encode_set_model("req_2", "claude-haiku-4-5-20251001").expect("encode");
        assert_eq!(encoded.matches('\n').count(), 1);
        assert!(encoded.ends_with('\n'));

        let value: Value = serde_json::from_str(encoded.trim_end()).expect("must parse");
        let expected = serde_json::json!({
            "type": "control_request",
            "request_id": "req_2",
            "request": { "subtype": "set_model", "model": "claude-haiku-4-5-20251001" },
        });
        assert_eq!(value, expected);
    }
}
