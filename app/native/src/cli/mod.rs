use serde_json::{Value, json};
use std::{
    env,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[cfg(any(windows, test))]
mod deadline;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

pub const FRAME_CAP: usize = 1024 * 1024;
pub const STDIN_CAP: usize = 10 * 1024 * 1024;
const HELP: &str = "Usage: simplemd [--wait] [--stdin-name NAME] [--] FILE[:LINE|#SLUG] | -\n       simplemd export FILE --format html|pdf -o OUTPUT [--force]\nExit codes: 0 success, 1 operational failure, 2 usage error.";
#[derive(Debug, PartialEq)]
pub enum Action {
    Open {
        path: PathBuf,
        line: Option<u32>,
        heading: Option<String>,
        wait: bool,
    },
    Stdin {
        name: String,
        wait: bool,
    },
    Export {
        path: PathBuf,
        output: PathBuf,
        format: String,
        overwrite: bool,
    },
    Help,
}
fn absolute(value: &str, cwd: &Path) -> PathBuf {
    let p = Path::new(value);
    if p.is_absolute() {
        p.to_owned()
    } else {
        cwd.join(p)
    }
}
pub fn parse(
    args: &[String],
    cwd: &Path,
    exists: impl Fn(&Path) -> bool,
) -> Result<Action, String> {
    if args == ["--help"] || args == ["-h"] {
        return Ok(Action::Help);
    }
    let export = args.first().is_some_and(|v| v == "export");
    let mut wait = false;
    let mut name = None;
    let mut format = None;
    let mut output = None;
    let mut overwrite = false;
    let mut literal = false;
    let mut files = vec![];
    let mut i = usize::from(export);
    while i < args.len() {
        let arg = &args[i];
        if literal {
            files.push(arg.as_str());
        } else {
            match arg.as_str() {
                "--" => literal = true,
                "--wait" if !export && !wait => wait = true,
                "--force" if export && !overwrite => overwrite = true,
                "--stdin-name" | "--format" | "-o" => {
                    i += 1;
                    let value = args.get(i).ok_or("Missing option value")?.clone();
                    match arg.as_str() {
                        "--stdin-name" if !export && name.is_none() => name = Some(value),
                        "--format" if export && format.is_none() => format = Some(value),
                        "-o" if export && output.is_none() => output = Some(value),
                        _ => return Err("Unexpected or repeated option".into()),
                    }
                }
                "-" => files.push(arg),
                v if v.starts_with('-') => return Err(format!("Unknown option: {v}")),
                _ => files.push(arg),
            }
        }
        i += 1;
    }
    if files.len() != 1 {
        return Err(HELP.into());
    }
    let file = files[0];
    #[cfg(windows)]
    if [Some(file), output.as_deref()]
        .into_iter()
        .flatten()
        .any(|v| {
            v.starts_with(['\\', '/'])
                && v.as_bytes()
                    .get(1)
                    .is_some_and(|b| *b == b'\\' || *b == b'/')
        })
    {
        return Err("UNC and device paths are forbidden".into());
    }
    if export {
        let format = format
            .filter(|v| v == "html" || v == "pdf")
            .ok_or("Choose --format html or pdf")?;
        let output = output
            .filter(|v| !v.is_empty())
            .ok_or("Specify -o OUTPUT")?;
        if file == "-" {
            return Err("Export requires a file".into());
        }
        return Ok(Action::Export {
            path: absolute(file, cwd),
            output: absolute(&output, cwd),
            format,
            overwrite,
        });
    }
    if file == "-" {
        let name = name.unwrap_or_else(|| "stdin.md".into());
        if name.is_empty() || name.len() > 255 || name.contains(['/', '\\', '\0', '\r', '\n']) {
            return Err("Invalid stdin name".into());
        }
        return Ok(Action::Stdin { name, wait });
    }
    if name.is_some() {
        return Err("--stdin-name requires stdin (-)".into());
    }
    let mut file = file;
    let mut line = None;
    let mut heading = None;
    if !exists(&absolute(file, cwd)) {
        if let Some((base, slug)) = file.rsplit_once('#') {
            if base.is_empty() || slug.is_empty() || slug.len() > 4096 {
                return Err("Invalid heading slug".into());
            }
            file = base;
            heading = Some(slug.to_owned());
        } else if let Some((base, number)) = file.rsplit_once(':')
            && !number.is_empty()
            && number.bytes().all(|v| v.is_ascii_digit())
        {
            line = Some(
                number
                    .parse::<u32>()
                    .ok()
                    .filter(|v| *v > 0)
                    .ok_or("Invalid line number")?,
            );
            file = base;
        }
    }
    Ok(Action::Open {
        path: absolute(file, cwd),
        line,
        heading,
        wait,
    })
}

pub fn write_frame(stream: &mut impl Write, bytes: &[u8], cap: usize) -> io::Result<()> {
    if bytes.is_empty() || bytes.len() > cap {
        return Err(io::Error::other("Frame exceeds limit"));
    }
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(bytes)?;
    stream.flush()
}
pub fn read_frame(stream: &mut impl Read, cap: usize) -> io::Result<Vec<u8>> {
    let mut header = [0; 4];
    stream.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > cap {
        return Err(io::Error::other("Frame exceeds limit"));
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes)?;
    Ok(bytes)
}
pub fn secret_matches(expected: &str, value: &str) -> bool {
    expected.len() == 64
        && value.len() == 64
        && expected
            .bytes()
            .zip(value.bytes())
            .fold(0, |diff, (a, b)| diff | (a ^ b))
            == 0
}
fn runtime_dir() -> Result<PathBuf, String> {
    #[cfg(any(debug_assertions, feature = "cli-test-hooks"))]
    if let Some(dir) = env::var_os("SMD_CLI_RUNTIME") {
        return Ok(PathBuf::from(dir));
    }
    platform::runtime_dir()
}
fn launch() -> Result<(), String> {
    #[cfg(any(debug_assertions, feature = "cli-test-hooks"))]
    if let Some(executable) = env::var_os("SMD_CLI_APP") {
        let mut command = Command::new(executable);
        if let Some(root) = env::var_os("SMD_CLI_APP_ROOT") {
            command.arg(root);
        }
        command
            .arg("--background")
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    let result = Command::new("/usr/bin/open")
        .args([
            "-g",
            "-b",
            "com.jonathanreed.simplemd",
            "--args",
            "--background",
        ])
        .status();
    #[cfg(target_os = "linux")]
    let result = Command::new("gtk-launch").arg("simplemd").status();
    #[cfg(windows)]
    let result = {
        let exe = env::current_exe().map_err(|e| e.to_string())?;
        let app = exe
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .ok_or("Cannot locate installed app")?
            .join("SimpleMD.exe");
        Command::new(app)
            .arg("--background")
            .spawn()
            .map(|_| std::process::ExitStatus::default())
    };
    if result.map_err(|e| e.to_string())?.success() {
        Ok(())
    } else {
        Err("Could not launch SimpleMD".into())
    }
}
fn execute(action: Action) -> Result<(), String> {
    let dir = runtime_dir()?;
    let mut stdin = Vec::new();
    if matches!(action, Action::Stdin { .. }) {
        io::stdin()
            .take((STDIN_CAP + 1) as u64)
            .read_to_end(&mut stdin)
            .map_err(|e| e.to_string())?;
        if stdin.len() > STDIN_CAP {
            return Err("Stdin exceeds 10 MiB".into());
        }
        std::str::from_utf8(&stdin).map_err(|_| "Stdin must be UTF-8")?;
    }
    let connect = || -> Result<_, String> {
        platform::validate_runtime(&dir)?;
        let state = platform::read_state(&dir)?;
        if state["version"] != 1
            || state["secret"]
                .as_str()
                .is_none_or(|v| !secret_matches(v, v))
        {
            return Err("Invalid connection state".into());
        }
        let stream = platform::connect(&dir)?;
        Ok((stream, state))
    };
    let (mut stream, state) = match connect() {
        Ok(pair) => pair,
        Err(_) => {
            launch()?;
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                match connect() {
                    Ok(pair) => break pair,
                    Err(error) if Instant::now() >= deadline => {
                        return Err(format!("Cannot connect to SimpleMD: {error}"));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(40)),
                }
            }
        }
    };
    let id = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let mut request = json!({"version":1, "id":id, "secret":state["secret"]});
    let wait = match action {
        Action::Open {
            path,
            line,
            heading,
            wait,
        } => {
            request["command"] = json!("open");
            request["path"] = json!(path);
            request["line"] = json!(line);
            request["heading"] = json!(heading);
            request["wait"] = json!(wait);
            wait
        }
        Action::Stdin { name, wait } => {
            request["command"] = json!("stdin");
            request["name"] = json!(name);
            request["length"] = json!(stdin.len());
            request["wait"] = json!(wait);
            wait
        }
        Action::Export {
            path,
            output,
            format,
            overwrite,
        } => {
            request["command"] = json!("export");
            request["path"] = json!(path);
            request["output"] = json!(output);
            request["format"] = json!(format);
            request["overwrite"] = json!(overwrite);
            false
        }
        Action::Help => return Ok(()),
    };
    write_frame(
        &mut stream,
        &serde_json::to_vec(&request).map_err(|e| e.to_string())?,
        FRAME_CAP,
    )
    .map_err(|e| e.to_string())?;
    // An empty stdin has no second frame.
    if request["command"] == "stdin" && !stdin.is_empty() {
        write_frame(&mut stream, &stdin, STDIN_CAP).map_err(|e| e.to_string())?;
    }
    let mut accepted = false;
    loop {
        let response: Value = serde_json::from_slice(
            &read_frame(&mut stream, FRAME_CAP).map_err(|e| format!("IPC failed: {e}"))?,
        )
        .map_err(|e| e.to_string())?;
        if response["version"] != 1 || response["id"] != id {
            return Err("Mismatched IPC response".into());
        }
        match response["status"].as_str() {
            Some("error") => {
                return Err(response["message"]
                    .as_str()
                    .unwrap_or("Request failed")
                    .into());
            }
            Some("accepted") if !accepted => {
                if !wait {
                    return Ok(());
                }
                accepted = true;
                platform::wait_forever(&stream)?;
            }
            Some("closed") if wait && accepted => return Ok(()),
            _ => return Err("Unexpected IPC response".into()),
        }
    }
}
pub fn run() -> Result<(), (i32, String)> {
    platform::interrupt_handler();
    let args: Vec<String> = env::args_os()
        .skip(1)
        .map(|v| {
            v.into_string()
                .map_err(|_| (2, "Arguments must be Unicode".into()))
        })
        .collect::<Result<_, _>>()?;
    #[cfg(windows)]
    if args.first().is_some_and(|v| v == "--ipc-broker") {
        return windows::broker().map_err(|e| (1, e));
    }
    #[cfg(windows)]
    if args.first().is_some_and(|v| v == "--runtime-info") {
        return windows::runtime_info().map_err(|e| (1, e));
    }
    let cwd = env::current_dir().map_err(|e| (1, e.to_string()))?;
    let action = parse(&args, &cwd, |p| p.exists()).map_err(|e| (2, e))?;
    if action == Action::Help {
        println!("{HELP}");
        return Ok(());
    }
    execute(action).map_err(|e| (1, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).into()).collect()
    }
    #[test]
    fn path_suffixes_and_literals() {
        let cwd = Path::new("/tmp");
        for file in ["a:42", "a#heading", "colon:name.md", "-dash.md"] {
            let input = args(&["--", file]);
            assert_eq!(
                parse(&input, cwd, |_| true).unwrap(),
                Action::Open {
                    path: cwd.join(file),
                    line: None,
                    heading: None,
                    wait: false
                }
            );
        }
        assert_eq!(
            parse(&args(&["a:42"]), cwd, |_| false).unwrap(),
            Action::Open {
                path: cwd.join("a"),
                line: Some(42),
                heading: None,
                wait: false
            }
        );
        assert_eq!(
            parse(&args(&["a#same-heading-1"]), cwd, |_| false).unwrap(),
            Action::Open {
                path: cwd.join("a"),
                line: None,
                heading: Some("same-heading-1".into()),
                wait: false
            }
        );
        assert!(parse(&args(&["a:0"]), cwd, |_| false).is_err());
        assert!(parse(&args(&["--stdin-name", "x", "a"]), cwd, |_| true).is_err());
        assert!(parse(&args(&["--wat", "a"]), cwd, |_| true).is_err());
        assert!(matches!(
            parse(
                &args(&["--wait", "--stdin-name", "note.mdx", "-"]),
                cwd,
                |_| false
            )
            .unwrap(),
            Action::Stdin { wait: true, .. }
        ));
        assert!(matches!(
            parse(
                &args(&["export", "x", "--format", "pdf", "-o", "out", "--force"]),
                cwd,
                |_| false
            )
            .unwrap(),
            Action::Export {
                overwrite: true,
                ..
            }
        ));
    }
    #[test]
    fn framing_and_caps() {
        let mut bytes = vec![];
        write_frame(&mut bytes, b"hello", FRAME_CAP).unwrap();
        assert_eq!(
            read_frame(&mut bytes.as_slice(), FRAME_CAP).unwrap(),
            b"hello"
        );
        for length in [0, FRAME_CAP + 1, STDIN_CAP + 1] {
            assert!(read_frame(&mut (length as u32).to_be_bytes().as_slice(), FRAME_CAP).is_err());
        }
        assert!(read_frame(&mut [0, 0, 0, 4, 1].as_slice(), FRAME_CAP).is_err());
        assert!(write_frame(&mut vec![], &vec![0; FRAME_CAP + 1], FRAME_CAP).is_err());
        let stdin = vec![b'a'; STDIN_CAP];
        let mut bytes = vec![];
        write_frame(&mut bytes, &stdin, STDIN_CAP).unwrap();
        assert_eq!(read_frame(&mut bytes.as_slice(), STDIN_CAP).unwrap(), stdin);
    }
    #[test]
    fn secrets() {
        assert!(secret_matches(&"a".repeat(64), &"a".repeat(64)));
        assert!(!secret_matches(&"a".repeat(64), &"b".repeat(64)));
        assert!(!secret_matches("", ""));
    }
}
