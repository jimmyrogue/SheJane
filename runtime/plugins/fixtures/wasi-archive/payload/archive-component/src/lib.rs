use std::io::{Cursor, Read};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

wit_bindgen::generate!({
    path: "wit",
    world: "action-plugin",
});

struct Archive;

impl Guest for Archive {
    fn invoke(invocation_json: String, input: Vec<u8>) -> String {
        match extract(&invocation_json, input) {
            Ok(result) => result.to_string(),
            Err(message) => json!({
                "status": "failed",
                "error": {
                    "code": "invalid_archive",
                    "message": message,
                    "retryable": false
                }
            })
            .to_string(),
        }
    }
}

export!(Archive);

fn extract(invocation_json: &str, input: Vec<u8>) -> Result<Value, String> {
    let invocation: Value =
        serde_json::from_str(invocation_json).map_err(|_| "invalid invocation")?;
    let output_limit = invocation["limits"]["output_mb"]
        .as_u64()
        .ok_or("missing output limit")?
        * 1024
        * 1024;
    let mut archive = zip::ZipArchive::new(Cursor::new(input)).map_err(|_| "invalid ZIP")?;
    let mut total = 0_u64;
    let mut artifacts = Vec::new();

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| "invalid ZIP entry")?;
        if entry.is_dir() {
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("symbolic links are not allowed".into());
        }
        let path = entry
            .enclosed_name()
            .ok_or("unsafe ZIP path")?
            .to_string_lossy()
            .replace('\\', "/");
        total = total
            .checked_add(entry.size())
            .ok_or("output size overflow")?;
        if total > output_limit {
            return Err("output limit exceeded".into());
        }
        let mut data = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut data)
            .map_err(|_| "cannot read ZIP entry")?;
        let name = path.rsplit('/').next().unwrap_or(&path);
        artifacts.push(json!({
            "path": format!("/output/archive/{path}"),
            "media_type": "application/octet-stream",
            "name": name,
            "data_base64": STANDARD.encode(data)
        }));
    }
    artifacts.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));

    Ok(json!({
        "status": "succeeded",
        "output": {"file_count": artifacts.len()},
        "artifacts": artifacts
    }))
}
