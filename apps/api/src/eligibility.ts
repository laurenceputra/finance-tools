// Clerk state changes share D1's write serialization with session insertion and
// CAS. A ban increments the account epoch; unban never decrements it, so old
// sessions/approved pairings cannot become valid again.
export function eligibilityStatements(
  env: Env,
  subject: string,
  banned: boolean,
  stateAt: number,
  observedAt: number,
  provision = false,
  acceptance?: { id: string; nonce: string },
) {
  const guard = acceptance ? 'EXISTS(SELECT 1 FROM webhooks WHERE id=? AND acceptance_id=?)' : '1';
  const extra = acceptance ? [acceptance.id, acceptance.nonce] : [];
  const statements: D1PreparedStatement[] = [];
  if (provision)
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO accounts(id,subject,created_at) SELECT ?,?,? WHERE ${guard}`,
      ).bind(crypto.randomUUID(), subject, observedAt, ...extra),
    );
  statements.push(
    env.DB.prepare(
      `UPDATE accounts SET
    session_epoch=session_epoch+CASE WHEN ?=1 AND disabled_at IS NULL THEN 1 ELSE 0 END,
    revocation_pending=CASE WHEN ?=1 AND disabled_at IS NULL THEN 1 ELSE revocation_pending END,
    disabled_at=CASE WHEN ?=1 THEN COALESCE(disabled_at,?) ELSE NULL END,clerk_state_at=?
    WHERE subject=? AND deleted_at IS NULL AND (? > clerk_state_at OR (?=clerk_state_at AND ?=1)) AND ${guard}`,
    ).bind(
      Number(banned),
      Number(banned),
      Number(banned),
      observedAt,
      stateAt,
      subject,
      stateAt,
      stateAt,
      Number(banned),
      ...extra,
    ),
  );
  return statements;
}
