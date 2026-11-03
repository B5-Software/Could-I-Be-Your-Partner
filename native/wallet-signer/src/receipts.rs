// SPDX-License-Identifier: GPL-3.0-or-later
//! Commit before acknowledgement. Signed bytes are encrypted at rest; the store
//! contains no passwords, private keys or mnemonics.
use crate::Result;
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, config::DbConfig, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, fs::File, fs::OpenOptions, path::Path, time::Duration};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};
const FAILED: &str = "WALLET_RECEIPT_STORE_FAILED";
// Explicit order keeps the authenticated encoding stable if JSON map features
// or the public summary gain fields in a future release.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Binding<'a> {
    address: &'a str,
    chain_id: u64,
    hash: &'a str,
    nonce: u64,
    operation_id: &'a str,
    store_id: &'a str,
    unsigned_hash: &'a str,
    version: u8,
    wallet_id: &'a str,
}
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub operation_id: String,
    pub wallet_id: String,
    pub address: String,
    pub unsigned_hash: String,
    pub hash: String,
    pub sealed_raw: String,
    pub nonce_hex: String,
    #[zeroize(skip)]
    pub chain_id: u64,
    #[zeroize(skip)]
    pub nonce: u64,
}
impl Receipt {
    fn aad(&self, store: &str) -> Result<Vec<u8>> {
        serde_json::to_vec(&Binding {
            address: &self.address,
            chain_id: self.chain_id,
            hash: &self.hash,
            nonce: self.nonce,
            operation_id: &self.operation_id,
            store_id: store,
            unsigned_hash: &self.unsigned_hash,
            version: 1,
            wallet_id: &self.wallet_id,
        })
        .map_err(|_| FAILED)
    }
    fn key(private_key: &[u8], store: &str) -> Result<Zeroizing<[u8; 32]>> {
        let mut key = Zeroizing::new([0u8; 32]);
        hkdf::Hkdf::<Sha256>::new(Some(store.as_bytes()), private_key)
            .expand(b"CIBYP-WALLET-SIGNING-RECEIPT/1", &mut *key)
            .map_err(|_| FAILED)?;
        Ok(key)
    }
    pub fn seal(&mut self, private_key: &[u8], store: &str, raw: &str) -> Result<()> {
        let key = Self::key(private_key, store)?;
        let nonce = crate::random::<24>()?;
        let bytes =
            Zeroizing::new(hex::decode(raw.strip_prefix("0x").ok_or(FAILED)?).map_err(|_| FAILED)?);
        let aad = self.aad(store)?;
        let ciphertext = XChaCha20Poly1305::new((&*key).into())
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &bytes,
                    aad: &aad,
                },
            )
            .map_err(|_| FAILED)?;
        self.sealed_raw = hex::encode(ciphertext);
        self.nonce_hex = hex::encode(nonce);
        Ok(())
    }
    pub fn open_raw(&self, private_key: &[u8], store: &str) -> Result<Zeroizing<String>> {
        let key = Self::key(private_key, store)?;
        let nonce = hex::decode(&self.nonce_hex).map_err(|_| FAILED)?;
        if nonce.len() != 24 || self.sealed_raw.len() > 34000 {
            return Err(FAILED);
        }
        let ciphertext = hex::decode(&self.sealed_raw).map_err(|_| FAILED)?;
        let aad = self.aad(store)?;
        let raw = Zeroizing::new(
            XChaCha20Poly1305::new((&*key).into())
                .decrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: &aad,
                    },
                )
                .map_err(|_| FAILED)?,
        );
        let raw = Zeroizing::new("0x".to_owned() + &hex::encode(&*raw));
        if crate::evm::raw_hash(&raw)? != self.hash {
            return Err(FAILED);
        }
        Ok(raw)
    }
    pub fn summary(&self, store: &str) -> serde_json::Value {
        serde_json::json!({"version":1,"storeId":store,"operationId":self.operation_id,
            "walletId":self.wallet_id,"address":self.address,"unsignedHash":self.unsigned_hash,
            "hash":self.hash,"chainId":self.chain_id,"nonce":self.nonce})
    }
}
pub struct Store {
    pub(crate) connection: Connection,
    pub id: String,
    _lock: File,
    healthy: bool,
}
fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}
fn regular(path: &Path) -> Result<()> {
    let stat = fs::symlink_metadata(path).map_err(|_| FAILED)?;
    if !stat.is_file() || stat.file_type().is_symlink() || stat.len() > 536870912 {
        return Err(FAILED);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if stat.permissions().mode() & 0o077 != 0 {
            return Err(FAILED);
        }
    }
    Ok(())
}
impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        if !directory.is_absolute() {
            return Err(FAILED);
        }
        // macOS exposes its temporary directory through /var -> /private/var.
        // Resolve the parent without accepting a symlink at the store itself.
        #[cfg(unix)]
        let canonical_directory = fs::canonicalize(directory.parent().ok_or(FAILED)?)
            .map_err(|_| FAILED)?
            .join(directory.file_name().ok_or(FAILED)?);
        #[cfg(unix)]
        let directory = canonical_directory.as_path();
        let mut builder = fs::DirBuilder::new();
        builder.recursive(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        let _directory_created = match builder.create(directory) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(_) => return Err(FAILED),
        };
        let stat = fs::symlink_metadata(directory).map_err(|_| FAILED)?;
        if !stat.is_dir() || stat.file_type().is_symlink() {
            return Err(FAILED);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if stat.permissions().mode() & 0o077 != 0 {
                return Err(FAILED);
            }
        }
        let lock_path = directory.join("writer.lock");
        let lock = match options().create_new(true).open(&lock_path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                regular(&lock_path)?;
                options().open(&lock_path).map_err(|_| FAILED)?
            }
            Err(_) => return Err(FAILED),
        };
        regular(&lock_path)?;
        lock.try_lock().map_err(|_| "WALLET_RECEIPT_STORE_BUSY")?;
        let file = directory.join("receipts.sqlite");
        let fresh = match options().create_new(true).open(&file) {
            Ok(file) => {
                file.sync_all().map_err(|_| FAILED)?;
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(_) => return Err(FAILED),
        };
        regular(&file)?;
        for suffix in ["-journal", "-wal", "-shm"] {
            let sidecar = directory.join(format!("receipts.sqlite{suffix}"));
            match fs::symlink_metadata(&sidecar) {
                Ok(_) => regular(&sidecar)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(FAILED),
            }
        }
        let mut connection = Connection::open_with_flags(
            &file,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|_| FAILED)?;
        connection
            .busy_timeout(Duration::from_secs(2))
            .map_err(|_| FAILED)?;
        for (config, value) in [
            (DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true),
            (DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false),
            (DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false),
            (DbConfig::SQLITE_DBCONFIG_ENABLE_VIEW, false),
        ] {
            connection
                .set_db_config(config, value)
                .map_err(|_| FAILED)?;
        }
        // EXTRA also synchronizes journal deletion. fullfsync requests Apple's
        // stronger F_FULLFSYNC where supported; filesystem/hardware guarantees apply.
        connection
            .execute_batch(
                "PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;
            PRAGMA fullfsync=ON; PRAGMA max_page_count=131072; PRAGMA cell_size_check=ON;",
            )
            .map_err(|_| FAILED)?;
        let page_size: u32 = connection
            .query_row("PRAGMA page_size", [], |r| r.get(0))
            .map_err(|_| FAILED)?;
        if page_size != 4096 {
            return Err(FAILED);
        }
        let integrity: String = connection
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(|_| FAILED)?;
        if integrity != "ok" {
            return Err(FAILED);
        }
        if fresh {
            let transaction = connection.transaction().map_err(|_| FAILED)?;
            transaction.execute_batch("CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,store_id TEXT NOT NULL,receipt_count INTEGER NOT NULL CHECK(receipt_count BETWEEN 0 AND 200000)) STRICT;
                CREATE TABLE receipts (operation_id TEXT PRIMARY KEY,body TEXT NOT NULL,checksum TEXT NOT NULL) STRICT;").map_err(|_| FAILED)?;
            transaction
                .execute(
                    "INSERT INTO metadata VALUES(1,1,?1,0)",
                    [hex::encode(crate::random::<32>()?)],
                )
                .map_err(|_| FAILED)?;
            transaction.commit().map_err(|_| FAILED)?;
            #[cfg(unix)]
            File::open(directory)
                .and_then(|f| f.sync_all())
                .map_err(|_| FAILED)?;
            #[cfg(unix)]
            if _directory_created {
                File::open(directory.parent().ok_or(FAILED)?)
                    .and_then(|f| f.sync_all())
                    .map_err(|_| FAILED)?;
            }
        }
        let (version, id): (u32, String) = connection
            .query_row(
                "SELECT version,store_id FROM metadata WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| FAILED)?;
        if version != 1
            || id.len() != 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(FAILED);
        }
        let mut store = Self {
            connection,
            id,
            _lock: lock,
            healthy: true,
        };
        store.validate_ledger()?;
        crate::authority::initialize(&mut store.connection)?;
        Ok(store)
    }
    pub fn check(&self, expected: &str) -> Result<()> {
        if !self.healthy {
            return Err(FAILED);
        }
        if expected != self.id {
            return Err("WALLET_RECEIPT_STORE_CHANGED");
        }
        Ok(())
    }
    pub fn get(&self, operation: &str) -> Result<Option<Receipt>> {
        if !self.healthy {
            return Err(FAILED);
        }
        let row: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT body,checksum FROM receipts WHERE operation_id=?1",
                [operation],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| FAILED)?;
        let Some((body, checksum)) = row else {
            return Ok(None);
        };
        let body = Zeroizing::new(body);
        if body.len() > 65536 || hex::encode(Sha256::digest(body.as_bytes())) != checksum {
            return Err(FAILED);
        }
        let receipt: Receipt = serde_json::from_str(&body).map_err(|_| FAILED)?;
        if receipt.operation_id != operation
            || receipt.nonce_hex.len() != 48
            || receipt.sealed_raw.len() > 34000
            || receipt.sealed_raw.len() < 34
        {
            return Err(FAILED);
        }
        Ok(Some(receipt))
    }
    /// Absence is evidence only after checking the complete ledger. This slower
    /// path is for recovery, not each new signature.
    pub fn prove_absent(&self, operation: &str) -> Result<()> {
        if self.get(operation)?.is_some() {
            return Err(FAILED);
        }
        self.validate_ledger()
    }
    fn validate_ledger(&self) -> Result<()> {
        self.check(&self.id)?;
        let integrity: String = self
            .connection
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(|_| FAILED)?;
        let count: i64 = self
            .connection
            .query_row("SELECT receipt_count FROM metadata WHERE id=1", [], |r| {
                r.get(0)
            })
            .map_err(|_| FAILED)?;
        let actual: i64 = self
            .connection
            .query_row("SELECT count(*) FROM receipts", [], |r| r.get(0))
            .map_err(|_| FAILED)?;
        if integrity != "ok" || count != actual {
            return Err(FAILED);
        }
        let mut statement = self
            .connection
            .prepare("SELECT operation_id FROM receipts")
            .map_err(|_| FAILED)?;
        let mut rows = statement.query([]).map_err(|_| FAILED)?;
        while let Some(row) = rows.next().map_err(|_| FAILED)? {
            let id: String = row.get(0).map_err(|_| FAILED)?;
            if self.get(&id)?.is_none() {
                return Err(FAILED);
            }
        }
        Ok(())
    }
    pub(crate) fn edit<T>(
        &mut self,
        operation: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T>,
    ) -> Result<T> {
        if !self.healthy {
            return Err(FAILED);
        }
        self.healthy = false;
        let transaction = self.connection.transaction().map_err(|_| FAILED)?;
        let value = match operation(&transaction) {
            Ok(value) => value,
            Err(code) => {
                transaction.rollback().map_err(|_| FAILED)?;
                self.healthy = code != FAILED;
                return Err(code);
            }
        };
        transaction.commit().map_err(|_| FAILED)?;
        self.healthy = true;
        Ok(value)
    }
    pub fn commit(&mut self, receipt: &Receipt) -> Result<()> {
        self.commit_checked(receipt, None)
    }
    pub(crate) fn commit_checked(
        &mut self,
        receipt: &Receipt,
        check: Option<&crate::authority::Check<'_>>,
    ) -> Result<()> {
        let body = Zeroizing::new(serde_json::to_string(receipt).map_err(|_| FAILED)?);
        if body.len() > 65536 {
            return Err(FAILED);
        }
        // Any failed write/commit poisons the connection. A restart must perform
        // SQLite recovery before absence can be trusted again.
        self.edit(|transaction| {
            if let Some(check) = check {
                crate::authority::check(transaction, check)?;
            }
            let count: i64 = transaction
                .query_row("SELECT receipt_count FROM metadata WHERE id=1", [], |r| {
                    r.get(0)
                })
                .map_err(|_| FAILED)?;
            if count >= 200000 {
                return Err("WALLET_RECEIPT_STORE_FULL");
            }
            transaction
                .execute(
                    "INSERT INTO receipts VALUES(?1,?2,?3)",
                    params![
                        receipt.operation_id,
                        body.as_str(),
                        hex::encode(Sha256::digest(body.as_bytes()))
                    ],
                )
                .map_err(|_| FAILED)?;
            transaction
                .execute(
                    "UPDATE metadata SET receipt_count=receipt_count+1 WHERE id=1",
                    [],
                )
                .map_err(|_| FAILED)?;
            if let Some(check) = check {
                crate::authority::consume(transaction, receipt, check)?;
            } else {
                crate::authority::record_nonce(transaction, receipt)?;
            }
            Ok(())
        })
    }
}
