PRAGMA foreign_keys = ON;
CREATE TABLE accounts (
 id TEXT PRIMARY KEY, subject TEXT NOT NULL UNIQUE, deleted_at INTEGER, disabled_at INTEGER,
 clerk_state_at INTEGER NOT NULL DEFAULT 0, session_epoch INTEGER NOT NULL DEFAULT 0, revocation_pending INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, vault TEXT, vault_revision INTEGER NOT NULL DEFAULT 0,
 key_version INTEGER, max_documents INTEGER NOT NULL DEFAULT 10000,
 max_bytes INTEGER NOT NULL DEFAULT 67108864,
 metadata_bytes INTEGER NOT NULL DEFAULT 0, metadata_limit INTEGER NOT NULL DEFAULT 16777216,
 receipt_count INTEGER NOT NULL DEFAULT 0, receipt_limit INTEGER NOT NULL DEFAULT 50000,
 cleanup_pending INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), client TEXT NOT NULL,
 created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, idle_expires INTEGER NOT NULL,
 absolute_expires INTEGER NOT NULL, revoked_at INTEGER, refresh_hash TEXT UNIQUE NOT NULL,
 account_epoch INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE INDEX sessions_epoch ON sessions(account_id,account_epoch,id);
CREATE INDEX sessions_epoch_live ON sessions(account_id,account_epoch,id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_idle ON sessions(idle_expires,id);
CREATE INDEX sessions_absolute ON sessions(absolute_expires,id);
CREATE INDEX sessions_revoked ON sessions(revoked_at,id) WHERE revoked_at IS NOT NULL;
CREATE TABLE refresh_history (
 hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL,
 successor TEXT, grace_until INTEGER NOT NULL
);
CREATE INDEX refresh_grace ON refresh_history(grace_until,hash) WHERE successor IS NOT NULL;
CREATE INDEX refresh_session ON refresh_history(session_id,hash);
CREATE TABLE pairings (
 id TEXT PRIMARY KEY, client TEXT NOT NULL, code_hash TEXT NOT NULL, secret_hash TEXT NOT NULL,
 expires INTEGER NOT NULL, guesses INTEGER NOT NULL DEFAULT 0, account_id TEXT REFERENCES accounts(id),
 session_id TEXT, recovery TEXT, recovered_until INTEGER, account_epoch INTEGER
);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX rate_expires ON rate_limits(expires,key);
CREATE INDEX pairings_expires ON pairings(expires,id);
CREATE INDEX pairings_account ON pairings(account_id,id);
CREATE TABLE blobs (
 key TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), bytes INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','committed','deleting')), expires INTEGER NOT NULL,
 occurred_at TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX blobs_account ON blobs(account_id,state);
CREATE INDEX blobs_state_expiry ON blobs(state,expires,key);
CREATE INDEX blobs_history ON blobs(occurred_at,key) WHERE occurred_at IS NOT NULL AND state<>'deleting';
CREATE INDEX blobs_account_cleanup ON blobs(account_id,key) WHERE state<>'deleting';
CREATE TABLE documents (
 account_id TEXT NOT NULL REFERENCES accounts(id), namespace TEXT NOT NULL, id TEXT NOT NULL,
 product TEXT NOT NULL CHECK(product IN ('portfolio','bank-subcaps')),
 revision INTEGER NOT NULL, blob_key TEXT REFERENCES blobs(key), occurred_at TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(account_id,namespace,id)
);
CREATE TABLE mutations (
 account_id TEXT NOT NULL REFERENCES accounts(id), namespace TEXT NOT NULL, document_id TEXT NOT NULL,
 product TEXT,
 id TEXT NOT NULL, hash TEXT NOT NULL, status INTEGER NOT NULL, response TEXT,
 blob_key TEXT REFERENCES blobs(key), occurred_at TEXT, created_at INTEGER NOT NULL,
 metadata_size INTEGER NOT NULL DEFAULT 512,
 PRIMARY KEY(account_id,namespace,document_id,id)
);
CREATE INDEX documents_blob ON documents(blob_key);
CREATE INDEX mutations_blob ON mutations(blob_key);
CREATE INDEX documents_history ON documents(occurred_at,account_id,id) WHERE namespace='history' AND blob_key IS NOT NULL;
CREATE INDEX mutations_history ON mutations(occurred_at,account_id,document_id,id) WHERE namespace='history' AND (blob_key IS NOT NULL OR response IS NOT NULL);
CREATE INDEX accounts_deleted ON accounts(deleted_at,id) WHERE deleted_at IS NOT NULL;
CREATE INDEX accounts_cleanup ON accounts(deleted_at,id) WHERE deleted_at IS NOT NULL AND cleanup_pending=1;
CREATE TABLE webhooks (id TEXT PRIMARY KEY, accepted_at INTEGER NOT NULL, acceptance_id TEXT);
CREATE INDEX webhook_age ON webhooks(accepted_at,id);
CREATE TABLE cleanup_state (id TEXT PRIMARY KEY, cursor TEXT);
CREATE INDEX accounts_revocations ON accounts(id) WHERE revocation_pending=1;
CREATE TABLE admission_limits (
 id INTEGER PRIMARY KEY CHECK(id=1), pairing_count INTEGER NOT NULL DEFAULT 0,
 rate_count INTEGER NOT NULL DEFAULT 0, max_pairings INTEGER NOT NULL DEFAULT 1000,
 max_rates INTEGER NOT NULL DEFAULT 10000
);
INSERT INTO admission_limits(id) VALUES(1);

CREATE TRIGGER pairing_admission BEFORE INSERT ON pairings BEGIN
 SELECT CASE WHEN (SELECT pairing_count>=max_pairings FROM admission_limits WHERE id=1) THEN RAISE(ABORT,'admission_capacity') END;
END;
CREATE TRIGGER pairing_admitted AFTER INSERT ON pairings BEGIN UPDATE admission_limits SET pairing_count=pairing_count+1 WHERE id=1; END;
CREATE TRIGGER pairing_removed AFTER DELETE ON pairings BEGIN UPDATE admission_limits SET pairing_count=pairing_count-1 WHERE id=1; END;
CREATE TRIGGER rate_admission BEFORE INSERT ON rate_limits WHEN NOT EXISTS(SELECT 1 FROM rate_limits WHERE key=NEW.key) BEGIN
 SELECT CASE WHEN (SELECT rate_count>=max_rates FROM admission_limits WHERE id=1) THEN RAISE(ABORT,'admission_capacity') END;
END;
CREATE TRIGGER rate_admitted AFTER INSERT ON rate_limits BEGIN UPDATE admission_limits SET rate_count=rate_count+1 WHERE id=1; END;
CREATE TRIGGER rate_removed AFTER DELETE ON rate_limits BEGIN UPDATE admission_limits SET rate_count=rate_count-1 WHERE id=1; END;

-- Conservative metadata accounting includes fixed row/index allowance and
-- UTF-8 receipt/vault response bytes. History scrubbing releases response bytes
-- but preserves the charged receipt/tombstone identity for permanent replay.
CREATE TRIGGER receipt_charge AFTER INSERT ON mutations BEGIN
 UPDATE accounts SET metadata_bytes=metadata_bytes+NEW.metadata_size,receipt_count=receipt_count+1 WHERE id=NEW.account_id;
END;
CREATE TRIGGER receipt_release AFTER DELETE ON mutations BEGIN
 UPDATE accounts SET metadata_bytes=MAX(0,metadata_bytes-OLD.metadata_size),receipt_count=MAX(0,receipt_count-1) WHERE id=OLD.account_id;
END;
CREATE TRIGGER receipt_resize AFTER UPDATE OF metadata_size ON mutations BEGIN
 UPDATE accounts SET metadata_bytes=MAX(0,metadata_bytes+NEW.metadata_size-OLD.metadata_size) WHERE id=NEW.account_id;
END;
CREATE TRIGGER document_charge AFTER INSERT ON documents BEGIN
 UPDATE accounts SET metadata_bytes=metadata_bytes+512 WHERE id=NEW.account_id;
END;
CREATE TRIGGER document_release AFTER DELETE ON documents BEGIN
 UPDATE accounts SET metadata_bytes=MAX(0,metadata_bytes-512) WHERE id=OLD.account_id;
END;
CREATE TRIGGER blob_budget BEFORE INSERT ON blobs BEGIN
 SELECT CASE WHEN (SELECT metadata_bytes+512>metadata_limit FROM accounts WHERE id=NEW.account_id) THEN RAISE(ABORT,'metadata_quota') END;
END;
CREATE TRIGGER blob_charge AFTER INSERT ON blobs BEGIN
 UPDATE accounts SET metadata_bytes=metadata_bytes+512 WHERE id=NEW.account_id;
END;
CREATE TRIGGER blob_release AFTER DELETE ON blobs BEGIN
 UPDATE accounts SET metadata_bytes=MAX(0,metadata_bytes-512) WHERE id=OLD.account_id;
END;
CREATE TRIGGER vault_resize AFTER UPDATE OF vault ON accounts BEGIN
 UPDATE accounts SET metadata_bytes=MAX(0,metadata_bytes+COALESCE(length(CAST(NEW.vault AS BLOB)),0)-COALESCE(length(CAST(OLD.vault AS BLOB)),0)) WHERE id=NEW.id;
END;
CREATE TRIGGER session_budget BEFORE INSERT ON sessions BEGIN
 SELECT CASE WHEN (SELECT metadata_bytes+1024>metadata_limit FROM accounts WHERE id=NEW.account_id) THEN RAISE(ABORT,'metadata_quota') END;
END;
CREATE TRIGGER session_charge AFTER INSERT ON sessions BEGIN
 UPDATE accounts SET metadata_bytes=metadata_bytes+1024 WHERE id=NEW.account_id;
END;
CREATE TRIGGER session_release AFTER DELETE ON sessions BEGIN
 UPDATE accounts SET metadata_bytes=MAX(0,metadata_bytes-1024) WHERE id=OLD.account_id;
END;
CREATE TRIGGER refresh_budget BEFORE INSERT ON refresh_history WHEN NOT EXISTS(SELECT 1 FROM refresh_history WHERE hash=NEW.hash) BEGIN
 SELECT CASE WHEN (SELECT metadata_bytes+768>metadata_limit FROM accounts WHERE id=(SELECT account_id FROM sessions WHERE id=NEW.session_id)) THEN RAISE(ABORT,'metadata_quota') END;
END;
CREATE TRIGGER refresh_charge AFTER INSERT ON refresh_history BEGIN
 UPDATE accounts SET metadata_bytes=metadata_bytes+768 WHERE id=(SELECT account_id FROM sessions WHERE id=NEW.session_id);
END;
CREATE TRIGGER refresh_release AFTER DELETE ON refresh_history BEGIN
 UPDATE accounts SET metadata_bytes=MAX(0,metadata_bytes-768) WHERE id=(SELECT account_id FROM sessions WHERE id=OLD.session_id);
END;
CREATE TRIGGER pairing_budget BEFORE UPDATE OF account_id ON pairings WHEN OLD.account_id IS NULL AND NEW.account_id IS NOT NULL BEGIN
 SELECT CASE WHEN (SELECT metadata_bytes+1024>metadata_limit FROM accounts WHERE id=NEW.account_id) THEN RAISE(ABORT,'metadata_quota') END;
END;
CREATE TRIGGER pairing_charge AFTER UPDATE OF account_id ON pairings WHEN OLD.account_id IS NULL AND NEW.account_id IS NOT NULL BEGIN
 UPDATE accounts SET metadata_bytes=metadata_bytes+1024 WHERE id=NEW.account_id;
END;
CREATE TRIGGER pairing_release AFTER DELETE ON pairings WHEN OLD.account_id IS NOT NULL BEGIN
 UPDATE accounts SET metadata_bytes=MAX(0,metadata_bytes-1024) WHERE id=OLD.account_id;
END;

-- A command row is an atomic CAS, receipt and pointer update. RAISE aborts the
-- entire D1 batch; no application read/modify/write lock is required.
CREATE TABLE commands (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, session_id TEXT NOT NULL, namespace TEXT NOT NULL,
 product TEXT,
 document_id TEXT NOT NULL, mutation_id TEXT NOT NULL, hash TEXT NOT NULL,
 expected INTEGER NOT NULL, blob_key TEXT, occurred_at TEXT, response TEXT,
 vault TEXT, key_version INTEGER, now INTEGER NOT NULL, updated_at TEXT NOT NULL, cutoff TEXT NOT NULL
);
CREATE TRIGGER apply_command BEFORE INSERT ON commands BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE a.id=NEW.account_id
   AND a.deleted_at IS NULL AND a.disabled_at IS NULL AND s.account_epoch=a.session_epoch AND s.id=NEW.session_id AND s.revoked_at IS NULL
  AND s.idle_expires>NEW.now AND s.absolute_expires>NEW.now
 ) THEN RAISE(ABORT,'inactive') END;
 SELECT CASE WHEN EXISTS (SELECT 1 FROM mutations WHERE account_id=NEW.account_id
  AND namespace=NEW.namespace AND document_id=NEW.document_id AND id=NEW.mutation_id AND hash<>NEW.hash)
  THEN RAISE(ABORT,'mutation_conflict') END;
 SELECT CASE WHEN EXISTS (SELECT 1 FROM mutations WHERE account_id=NEW.account_id
  AND namespace=NEW.namespace AND document_id=NEW.document_id AND id=NEW.mutation_id AND hash=NEW.hash)
  THEN RAISE(IGNORE) END;
 SELECT CASE WHEN (SELECT receipt_count>=receipt_limit FROM accounts WHERE id=NEW.account_id) THEN RAISE(ABORT,'metadata_quota') END;
 SELECT CASE WHEN NEW.namespace<>'vault' AND (
  NOT EXISTS(SELECT 1 FROM sessions s,json_each(s.client,'$.products') p WHERE s.id=NEW.session_id AND p.value=NEW.product)
  OR EXISTS(SELECT 1 FROM documents WHERE account_id=NEW.account_id AND namespace=NEW.namespace AND id=NEW.document_id AND product<>NEW.product))
  THEN RAISE(ABORT,'product_scope') END;
 SELECT CASE WHEN (SELECT metadata_bytes+512+COALESCE(length(CAST(NEW.response AS BLOB)),0)
  +CASE WHEN NEW.namespace='vault' THEN COALESCE(length(CAST(NEW.vault AS BLOB)),0)-COALESCE(length(CAST(vault AS BLOB)),0)
    WHEN NOT EXISTS(SELECT 1 FROM documents WHERE account_id=NEW.account_id AND namespace=NEW.namespace AND id=NEW.document_id) THEN 512 ELSE 0 END
  >metadata_limit FROM accounts WHERE id=NEW.account_id) THEN RAISE(ABORT,'metadata_quota') END;
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM mutations WHERE account_id=NEW.account_id
  AND namespace=NEW.namespace AND document_id=NEW.document_id AND id=NEW.mutation_id)
  AND NEW.expected<>CASE WHEN NEW.namespace='vault' THEN (SELECT vault_revision FROM accounts WHERE id=NEW.account_id)
  ELSE COALESCE((SELECT revision FROM documents WHERE account_id=NEW.account_id AND namespace=NEW.namespace AND id=NEW.document_id),0) END
  THEN RAISE(ABORT,'revision_conflict') END;
 SELECT CASE WHEN NEW.namespace='vault' AND EXISTS (SELECT 1 FROM accounts WHERE id=NEW.account_id
  AND key_version IS NOT NULL AND key_version<>NEW.key_version) THEN RAISE(ABORT,'key_version') END;
 SELECT CASE WHEN NEW.blob_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts a JOIN blobs b ON b.account_id=a.id
  WHERE a.id=NEW.account_id AND a.key_version=NEW.key_version AND b.key=NEW.blob_key
  AND b.state='pending' AND b.expires>NEW.now) THEN RAISE(ABORT,'key_version') END;
 SELECT CASE WHEN NEW.namespace='history' AND NEW.blob_key IS NOT NULL AND NEW.occurred_at<NEW.cutoff
  THEN RAISE(ABORT,'expired_history') END;
 SELECT CASE WHEN NEW.blob_key IS NOT NULL AND
  ((SELECT COUNT(*) FROM documents WHERE account_id=NEW.account_id AND blob_key IS NOT NULL)
    + CASE WHEN EXISTS(SELECT 1 FROM documents WHERE account_id=NEW.account_id AND namespace=NEW.namespace AND id=NEW.document_id AND blob_key IS NOT NULL) THEN 0 ELSE 1 END
    >(SELECT max_documents FROM accounts WHERE id=NEW.account_id)
   OR (SELECT COALESCE(SUM(bytes),0) FROM blobs WHERE account_id=NEW.account_id)
    >(SELECT max_bytes FROM accounts WHERE id=NEW.account_id))
  THEN RAISE(ABORT,'quota') END;
 UPDATE accounts SET vault=NEW.vault,vault_revision=vault_revision+1,key_version=NEW.key_version
  WHERE id=NEW.account_id AND NEW.namespace='vault' AND NOT EXISTS(SELECT 1 FROM mutations WHERE account_id=NEW.account_id AND namespace=NEW.namespace AND document_id=NEW.document_id AND id=NEW.mutation_id);
 INSERT INTO documents(account_id,namespace,id,product,revision,blob_key,occurred_at,updated_at)
  SELECT NEW.account_id,NEW.namespace,NEW.document_id,NEW.product,NEW.expected+1,NEW.blob_key,NEW.occurred_at,NEW.updated_at
  WHERE NEW.namespace<>'vault' AND NOT EXISTS(SELECT 1 FROM mutations WHERE account_id=NEW.account_id AND namespace=NEW.namespace AND document_id=NEW.document_id AND id=NEW.mutation_id)
  ON CONFLICT(account_id,namespace,id) DO UPDATE SET revision=excluded.revision,blob_key=excluded.blob_key,occurred_at=excluded.occurred_at,updated_at=excluded.updated_at;
 UPDATE blobs SET state='committed' WHERE key=NEW.blob_key AND NOT EXISTS(SELECT 1 FROM mutations WHERE account_id=NEW.account_id AND namespace=NEW.namespace AND document_id=NEW.document_id AND id=NEW.mutation_id);
 INSERT OR IGNORE INTO mutations(account_id,namespace,document_id,product,id,hash,status,response,blob_key,occurred_at,created_at,metadata_size)
  VALUES(NEW.account_id,NEW.namespace,NEW.document_id,NEW.product,NEW.mutation_id,NEW.hash,
   CASE WHEN NEW.namespace<>'vault' AND NEW.blob_key IS NULL THEN 204 ELSE 200 END,NEW.response,NEW.blob_key,NEW.occurred_at,NEW.now,512+COALESCE(length(CAST(NEW.response AS BLOB)),0));
END;
CREATE TRIGGER discard_command AFTER INSERT ON commands BEGIN DELETE FROM commands WHERE id=NEW.id; END;
