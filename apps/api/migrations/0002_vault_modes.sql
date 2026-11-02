-- Additive: a non-null legacy vault remains Private. Server wraps never enter public vault JSON.
ALTER TABLE accounts ADD COLUMN server_vault_wrap TEXT;
ALTER TABLE accounts ADD COLUMN vault_mutation TEXT;

-- Timestamps are milliseconds. Existing sessions are capped from their original dates,
-- not granted a fresh lifetime at migration.
UPDATE sessions SET absolute_expires=MIN(absolute_expires,created_at+7776000000),
 idle_expires=MIN(idle_expires,last_used_at+2592000000,created_at+7776000000,absolute_expires);

CREATE TRIGGER vault_wrap_delete AFTER UPDATE OF deleted_at ON accounts WHEN NEW.deleted_at IS NOT NULL BEGIN
 UPDATE accounts SET server_vault_wrap=NULL,vault_mutation=NULL WHERE id=NEW.id;
END;
CREATE TRIGGER vault_wrap_budget BEFORE UPDATE OF server_vault_wrap ON accounts BEGIN
 SELECT CASE WHEN NEW.metadata_bytes+COALESCE(length(CAST(NEW.server_vault_wrap AS BLOB)),0)-COALESCE(length(CAST(OLD.server_vault_wrap AS BLOB)),0)>NEW.metadata_limit THEN RAISE(ABORT,'metadata_quota') END;
END;
CREATE TRIGGER vault_wrap_resize AFTER UPDATE OF server_vault_wrap ON accounts BEGIN
 UPDATE accounts SET metadata_bytes=MAX(0,metadata_bytes+COALESCE(length(CAST(NEW.server_vault_wrap AS BLOB)),0)-COALESCE(length(CAST(OLD.server_vault_wrap AS BLOB)),0)) WHERE id=NEW.id;
END;
-- Old clients may rewrap a Private vault but cannot replace a Standard key.
CREATE TRIGGER private_vault_command BEFORE INSERT ON commands WHEN NEW.namespace='vault' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND server_vault_wrap IS NOT NULL) THEN RAISE(ABORT,'revision_conflict') END;
END;
