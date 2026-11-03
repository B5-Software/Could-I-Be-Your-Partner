//! Exclusive writer, chained integrity, sync-before-ack. Never truncate recovery
//! evidence automatically after a torn write or a failed durable commit.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::Path;

#[cfg(unix)]
fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.mode(0o600);
    options
}
#[cfg(not(unix))]
fn private_options() -> OpenOptions {
    OpenOptions::new()
}
fn regular_or_missing(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(value) if !value.is_file() || value.file_type().is_symlink() => {
            Err(io::Error::other("JOURNAL_FILE_NOT_REGULAR"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub const MAX_FRAME: usize = 1024 * 1024;
pub const MAX_JOURNAL_RECORD: usize = 16 * 1024 * 1024;
pub fn line<R: BufRead>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    line_limit(reader, MAX_FRAME)
}
fn line_limit<R: BufRead>(reader: &mut R, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut result = Vec::new();
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return if result.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::other("TORN_JOURNAL_OR_IPC_FRAME"))
            };
        }
        let end = bytes.iter().position(|b| *b == b'\n');
        let count = end.map_or(bytes.len(), |i| i + 1);
        if result.len() + count > limit {
            return Err(io::Error::other("FRAME_LIMIT"));
        }
        result.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if end.is_some() {
            return Ok(Some(result));
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    version: u8,
    sequence: u64,
    previous: String,
    payload: String,
    hash: String,
}
fn hash(sequence: u64, previous: &str, payload: &str) -> String {
    let mut sha = Sha256::new();
    sha.update(sequence.to_be_bytes());
    sha.update(previous.as_bytes());
    sha.update(payload.as_bytes());
    sha.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub struct Journal {
    file: File,
    _lock: File,
    pub sequence: u64,
    previous: String,
    size: u64,
    quota: u64,
    poisoned: bool,
}
impl Journal {
    pub fn open(
        directory: &Path,
        quota: u64,
        mut apply: impl FnMut(Value) -> io::Result<()>,
    ) -> io::Result<Self> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(directory)?;
        regular_or_missing(&directory.join("engine.lock"))?;
        let lock = private_options()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("engine.lock"))?;
        lock.try_lock()
            .map_err(|_| io::Error::other("JOURNAL_ALREADY_OWNED_OR_LOCK_UNAVAILABLE"))?;
        let wal = directory.join("events.jsonl");
        regular_or_missing(&wal)?;
        let existed = wal.exists();
        let file = private_options()
            .create(true)
            .truncate(false)
            .read(true)
            .append(true)
            .open(&wal)?;
        let size = file.metadata()?.len();
        if size > quota {
            return Err(io::Error::other("JOURNAL_QUOTA"));
        }
        if !existed {
            file.sync_all()?;
            #[cfg(unix)]
            File::open(directory)?.sync_all()?;
        }
        let (mut sequence, mut previous) = (0, "0".repeat(64));
        let mut reader = BufReader::new(File::open(&wal)?);
        while let Some(bytes) = line_limit(&mut reader, MAX_JOURNAL_RECORD)? {
            let entry: Entry = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
            if entry.version != 1
                || entry.sequence != sequence + 1
                || entry.previous != previous
                || entry.hash != hash(entry.sequence, &entry.previous, &entry.payload)
            {
                return Err(io::Error::other("JOURNAL_INTEGRITY_ERROR"));
            }
            apply(serde_json::from_str(&entry.payload).map_err(io::Error::other)?)?;
            sequence = entry.sequence;
            previous = entry.hash;
        }
        Ok(Self {
            file,
            _lock: lock,
            sequence,
            previous,
            size,
            quota,
            poisoned: false,
        })
    }
    pub fn append(&mut self, event: &impl Serialize) -> io::Result<u64> {
        if self.poisoned {
            return Err(io::Error::other("JOURNAL_RESTART_REQUIRED"));
        }
        let payload = serde_json::to_string(event).map_err(io::Error::other)?;
        let sequence = self
            .sequence
            .checked_add(1)
            .ok_or_else(|| io::Error::other("JOURNAL_SEQUENCE_LIMIT"))?;
        let checksum = hash(sequence, &self.previous, &payload);
        let entry = Entry {
            version: 1,
            sequence,
            previous: self.previous.clone(),
            payload,
            hash: checksum.clone(),
        };
        let mut encoded = serde_json::to_vec(&entry).map_err(io::Error::other)?;
        encoded.push(b'\n');
        if encoded.len() > MAX_JOURNAL_RECORD {
            return Err(io::Error::other("FRAME_LIMIT"));
        }
        if self.size + encoded.len() as u64 > self.quota {
            return Err(io::Error::other("JOURNAL_QUOTA"));
        }
        if let Err(error) = self
            .file
            .write_all(&encoded)
            .and_then(|()| self.file.sync_all())
        {
            self.poisoned = true;
            return Err(error);
        }
        self.sequence = sequence;
        self.previous = checksum;
        self.size += encoded.len() as u64;
        Ok(sequence)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "cibyp-journal-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    #[test]
    fn durable_replay_and_exclusive_writer() {
        let directory = dir();
        let mut journal = Journal::open(&directory, 100000, |_| Ok(())).unwrap();
        assert!(Journal::open(&directory, 100000, |_| Ok(())).is_err());
        journal
            .append(&serde_json::json!({"amount":"0.000000000000000001"}))
            .unwrap();
        drop(journal);
        let mut rows = Vec::new();
        let restored = Journal::open(&directory, 100000, |value| {
            rows.push(value);
            Ok(())
        })
        .unwrap();
        assert_eq!(restored.sequence, 1);
        assert_eq!(rows.len(), 1);
        drop(restored);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn corrupt_or_torn_history_is_never_silently_discarded() {
        let directory = dir();
        let mut journal = Journal::open(&directory, 100000, |_| Ok(())).unwrap();
        journal.append(&serde_json::json!({"n":1})).unwrap();
        drop(journal);
        let file = directory.join("events.jsonl");
        let original = fs::read(&file).unwrap();
        let mut torn = original.clone();
        torn.pop();
        fs::write(&file, torn).unwrap();
        assert!(Journal::open(&directory, 100000, |_| Ok(())).is_err());
        let modified = String::from_utf8(original)
            .unwrap()
            .replace("\\\"n\\\":1", "\\\"n\\\":2");
        fs::write(&file, modified).unwrap();
        assert!(Journal::open(&directory, 100000, |_| Ok(())).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn quota_and_frame_limits_do_not_publish_new_sequence() {
        let directory = dir();
        let mut journal = Journal::open(&directory, 10, |_| Ok(())).unwrap();
        assert!(journal.append(&serde_json::json!({"amount":"1"})).is_err());
        assert_eq!(journal.sequence, 0);
        drop(journal);
        assert_eq!(
            fs::metadata(directory.join("events.jsonl")).unwrap().len(),
            0
        );
        fs::remove_dir_all(directory).unwrap();
        assert!(line(&mut std::io::Cursor::new(vec![b'x'; MAX_FRAME + 1])).is_err());
    }
}
