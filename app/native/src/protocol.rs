//! Wire types for the newline-delimited JSON protocol spoken over stdio.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionState {
    Granted,
    /// Only the macOS backend reports this.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Missing,
    /// Only the fallback backend reports this.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unsupported,
}

/// Helper -> app, one per stdout line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum Event {
    Ready {
        platform: &'static str,
        permission: PermissionState,
    },
    /// Only the macOS backend reports permission changes.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Permission {
        state: PermissionState,
    },
    /// Speculative pre-render input. Never authorizes interception of a later keypress.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Selection {
        paths: Vec<String>,
    },
    Peek {
        #[serde(rename = "requestId")]
        request_id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        origin: Option<String>,
        app: String,
        /// Markdown files already known to be selected. Empty when the backend cannot tell,
        /// in which case the app looks the selection up itself.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        paths: Vec<String>,
    },
    #[serde(rename = "peek-valid")]
    PeekValid {
        #[serde(rename = "requestId")]
        request_id: u64,
        valid: bool,
    },
    Error {
        message: String,
    },
}

impl Event {
    pub fn error(message: impl Into<String>) -> Self {
        Event::Error {
            message: message.into(),
        }
    }

    pub fn to_line(&self) -> String {
        serde_json::to_string(self).expect("events are always serializable")
    }
}

/// App -> helper, one per stdin line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "cmd", rename_all = "kebab-case")]
pub enum Command {
    ReplaySpace {
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    ValidatePeek {
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    CompletePeek {
        #[serde(rename = "requestId")]
        request_id: u64,
    },
    SetEnabled {
        enabled: bool,
    },
    Quit,
}

pub fn parse_command(line: &str) -> Result<Command, serde_json::Error> {
    serde_json::from_str(line)
}

/// Output of the hidden `--probe` flag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub frontmost: String,
    pub text_input_focused: bool,
    pub accessibility: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_ready() {
        let e = Event::Ready {
            platform: "macos",
            permission: PermissionState::Granted,
        };
        assert_eq!(
            e.to_line(),
            r#"{"event":"ready","platform":"macos","permission":"granted"}"#
        );
    }

    #[test]
    fn serializes_permission_peek_error() {
        let p = Event::Permission {
            state: PermissionState::Missing,
        };
        assert_eq!(p.to_line(), r#"{"event":"permission","state":"missing"}"#);

        let peek = Event::Peek {
            request_id: 1,
            origin: None,
            app: "com.apple.finder".into(),
            paths: vec![],
        };
        assert_eq!(
            peek.to_line(),
            r#"{"event":"peek","requestId":1,"app":"com.apple.finder"}"#
        );
        let peek = Event::Peek {
            request_id: 1,
            origin: None,
            app: "com.apple.finder".into(),
            paths: vec!["/a.md".into()],
        };
        assert_eq!(
            peek.to_line(),
            r#"{"event":"peek","requestId":1,"app":"com.apple.finder","paths":["/a.md"]}"#
        );

        let err = Event::error("boom \"quoted\"\n");
        assert_eq!(
            err.to_line(),
            r#"{"event":"error","message":"boom \"quoted\"\n"}"#
        );
        assert!(!err.to_line().contains('\n'));
    }

    #[test]
    fn serializes_unsupported_permission() {
        let e = Event::Ready {
            platform: "linux",
            permission: PermissionState::Unsupported,
        };
        assert!(e.to_line().contains(r#""permission":"unsupported""#));
    }

    #[test]
    fn parses_commands() {
        assert_eq!(
            parse_command(r#"{"cmd":"replay-space","requestId":1}"#).unwrap(),
            Command::ReplaySpace { request_id: 1 }
        );
        assert_eq!(
            parse_command(r#"{"cmd":"set-enabled","enabled":false}"#).unwrap(),
            Command::SetEnabled { enabled: false }
        );
        assert_eq!(parse_command(r#"{"cmd":"quit"}"#).unwrap(), Command::Quit);
    }

    #[test]
    fn ignores_unknown_fields_but_rejects_unknown_commands() {
        assert_eq!(
            parse_command(r#"{"cmd":"quit","extra":1}"#).unwrap(),
            Command::Quit
        );
        assert!(parse_command(r#"{"cmd":"explode"}"#).is_err());
        assert!(parse_command(r#"{"cmd":"set-enabled"}"#).is_err());
        assert!(parse_command("not json").is_err());
        assert!(parse_command("{}").is_err());
        assert!(parse_command(r#"{"cmd":"replay-space"}"#).is_err());
        assert_eq!(
            parse_command(r#"{"cmd":"complete-peek","requestId":17}"#).unwrap(),
            Command::CompletePeek { request_id: 17 }
        );
    }

    #[test]
    fn serializes_probe_camel_case() {
        let p = Probe {
            frontmost: "com.apple.finder".into(),
            text_input_focused: false,
            accessibility: true,
            paths: None,
        };
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"frontmost":"com.apple.finder","textInputFocused":false,"accessibility":true}"#
        );
    }

    #[test]
    fn validates_exact_peek_request() {
        assert_eq!(
            parse_command(r#"{"cmd":"validate-peek","requestId":31}"#).unwrap(),
            Command::ValidatePeek { request_id: 31 }
        );
        assert_eq!(
            Event::PeekValid {
                request_id: 31,
                valid: false
            }
            .to_line(),
            r#"{"event":"peek-valid","requestId":31,"valid":false}"#
        );
    }
}
