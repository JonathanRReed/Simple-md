// Kept separate so the exact bytes-to-page boundary can be checked on any host.
#[cfg_attr(not(windows), allow(dead_code))]
pub const INPUT_LIMIT: usize = 2048;

#[cfg_attr(not(windows), allow(dead_code))]
pub fn preview_html(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(INPUT_LIMIT)]);
    let mut escaped = String::new();
    for c in text.chars() {
        match c {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            '\0' => escaped.push('\u{fffd}'),
            _ => escaped.push(c),
        }
    }
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; \
         script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">\
         <title>SimpleMD preview spike</title>\
         <style>body{{font:16px system-ui;margin:24px}}pre{{white-space:pre-wrap;overflow-wrap:anywhere}}</style>\
         </head><body><h1>SimpleMD preview spike</h1><pre>{escaped}</pre></body></html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_markup_is_text_and_input_is_bounded() {
        let mut input = b"<script>alert('x')</script>&\"".to_vec();
        input.resize(INPUT_LIMIT, b'a');
        input.extend_from_slice(b"SHOULD_NOT_APPEAR");
        let html = preview_html(&input);
        assert!(html.contains("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;&quot;"));
        assert!(!html.contains("<script>"));
        assert!(!html.contains("SHOULD_NOT_APPEAR"));
        assert!(html.contains("script-src 'none'"));
    }

    #[test]
    fn split_utf8_and_empty_streams_still_produce_a_page() {
        assert!(preview_html(&[0xf0, 0x9f]).contains('\u{fffd}'));
        let html = preview_html(b"before\0after");
        assert!(html.contains("before\u{fffd}after"));
        assert!(!html.contains('\0'));
        assert!(preview_html(&[]).contains("<pre></pre>"));
    }
}
