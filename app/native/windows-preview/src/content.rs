use std::{cell::Cell, io};

pub const INPUT_LIMIT: usize = 4 * 1024 * 1024;
pub const FALLBACK_LIMIT: usize = 128 * 1024;

pub struct Input {
    pub text: String,
    pub truncated: bool,
    pub invalid_utf8: bool,
}

// Read until EOF, including short reads, with one extra byte to detect truncation.
pub fn read_bounded(mut read: impl FnMut(&mut [u8]) -> io::Result<usize>) -> io::Result<Input> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    while bytes.len() <= INPUT_LIMIT {
        let remaining = (INPUT_LIMIT + 1 - bytes.len()).min(chunk.len());
        let count = read(&mut chunk[..remaining])?;
        if count > remaining {
            return Err(io::Error::other("Invalid stream byte count"));
        }
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let truncated = bytes.len() > INPUT_LIMIT;
    bytes.truncate(INPUT_LIMIT);
    let invalid_utf8 = std::str::from_utf8(&bytes).is_err();
    Ok(Input {
        text: String::from_utf8_lossy(&bytes).replace('\0', "\u{fffd}"),
        truncated,
        invalid_utf8,
    })
}

// No author byte is executable syntax, including quotes and Unicode separators.
pub fn js_string(text: &str) -> String {
    use std::fmt::Write;
    let mut result = String::from("\"");
    for unit in text.encode_utf16() {
        write!(&mut result, "\\u{unit:04x}").expect("String write");
    }
    result.push('"');
    result
}

pub fn render_script(bundle: &str, input: &Input) -> String {
    format!(
        "{bundle}\nSimpleMDRenderCore.renderStaticHtml({},null,{{truncated:{},invalidUtf8:{}}})\
         .then(html=>chrome.webview.postMessage(html))\
         .catch(()=>chrome.webview.postMessage(''));",
        js_string(&input.text),
        input.truncated,
        input.invalid_utf8
    )
}

// EDIT receives literal UTF-16, never HTML. Cap its separate display allocation.
pub fn fallback_text(input: &Input) -> String {
    let mut text: String = input.text.chars().take(FALLBACK_LIMIT).collect();
    if text.len() < input.text.len() || input.truncated {
        text.push_str("\n\n[Preview truncated. Open in SimpleMD to read the whole file.]");
    }
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\r\n")
}

#[derive(Default)]
pub struct Generation(Cell<u64>);
impl Generation {
    pub fn get(&self) -> u64 {
        self.0.get()
    }
    pub fn cancel(&self) {
        self.0.set(self.get().wrapping_add(1));
    }
    pub fn current(&self, generation: u64) -> bool {
        self.get() == generation
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn stream_bounds_short_reads_and_invalid_utf8() {
        let bytes = vec![b'a'; INPUT_LIMIT + 20];
        let mut cursor = bytes.as_slice();
        let input = read_bounded(|chunk| {
            let length = chunk.len().min(3);
            cursor.read(&mut chunk[..length])
        })
        .unwrap();
        assert_eq!(input.text.len(), INPUT_LIMIT);
        assert!(input.truncated);
        assert_eq!(cursor.len(), 19);
        let mut bytes = &[0xff, 0, b'x'][..];
        let input = read_bounded(|chunk| bytes.read(chunk)).unwrap();
        assert_eq!(input.text, "\u{fffd}\u{fffd}x");
        assert!(input.invalid_utf8);
        assert!(!input.truncated);
        assert!(read_bounded(|chunk| Ok(chunk.len() + 1)).is_err());
        let mut empty = &b""[..];
        assert!(
            read_bounded(|chunk| empty.read(chunk))
                .unwrap()
                .text
                .is_empty()
        );
        let exact_bytes = vec![b'a'; INPUT_LIMIT];
        let mut exact = exact_bytes.as_slice();
        assert!(!read_bounded(|chunk| exact.read(chunk)).unwrap().truncated);
    }

    #[test]
    fn author_content_is_data_and_native_fallback_is_literal() {
        for attack in [
            "<script>alert(1)</script>",
            "<img onerror=alert(1)>",
            "[x](javascript:alert(1))",
            "![x](https://example.com/x)",
            "import X from 'evil';\n<X />\n{globalThis.pwned=true}",
            "\");chrome.webview.postMessage('pwned');//\u{2028}",
        ] {
            let input = Input {
                text: attack.into(),
                truncated: false,
                invalid_utf8: false,
            };
            let script = render_script("/* trusted bundle */", &input);
            assert!(!script.contains(attack));
            assert_eq!(fallback_text(&input), attack.replace('\n', "\r\n"));
        }
        let input = Input {
            text: "x".repeat(FALLBACK_LIMIT + 10),
            truncated: false,
            invalid_utf8: false,
        };
        assert!(
            fallback_text(&input)
                .ends_with("[Preview truncated. Open in SimpleMD to read the whole file.]")
        );
    }

    #[test]
    fn cancellation_rejects_every_earlier_generation() {
        let generation = Generation::default();
        for old in 0..10 {
            assert!(generation.current(old));
            generation.cancel();
            for stale in 0..=old {
                assert!(!generation.current(stale));
            }
        }
    }
}
