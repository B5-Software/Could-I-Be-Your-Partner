#[cfg(unix)]
#[test]
fn private_storage_and_no_linked_journal_files() {
    use cibyp_quant_engine::journal::Journal;
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
        time::{SystemTime, UNIX_EPOCH},
    };
    let parent = std::env::temp_dir().canonicalize().unwrap();
    let path = parent.join(format!(
        "cibyp-native-private-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    {
        let mut journal = Journal::open(&path, 10000, |_| Ok(())).unwrap();
        journal
            .append(&serde_json::json!({"value":"private"}))
            .unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for file in ["engine.lock", "events.jsonl"] {
            assert_eq!(
                fs::metadata(path.join(file)).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    let target = path.join("unrelated");
    fs::write(&target, "").unwrap();
    fs::remove_file(path.join("events.jsonl")).unwrap();
    symlink(&target, path.join("events.jsonl")).unwrap();
    assert!(Journal::open(&path, 10000, |_| Ok(())).is_err());
    assert_eq!(fs::metadata(target).unwrap().len(), 0);
    assert!(
        path.is_absolute()
            && path.starts_with(&parent)
            && path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("cibyp-native-private-")
    );
    fs::remove_dir_all(path).unwrap();
}
