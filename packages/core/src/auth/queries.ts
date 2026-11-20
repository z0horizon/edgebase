import { sql } from "../db/registry";

// Every statement of auth (sessions, users, verification, passkeys, trusted devices), named
// for the plan test and D1 metrics (see db/registry.ts). Callers prepare and bind them.

export const PASSKEY_COUNTS = sql(
  "auth.passkey.counts",
  "DB",
  `SELECT
    (SELECT count(*) FROM passkey WHERE userId = ?1) AS passkeys,
    EXISTS(SELECT 1 FROM account WHERE userId = ?1 AND providerId <> 'credential') AS hasSocial`,
);

export const PASSKEY_DELETE = sql(
  "auth.passkey.delete",
  "DB",
  "DELETE FROM passkey WHERE id = ? AND userId = ?",
);

export const PASSKEY_FACTOR_COUNT = sql(
  "auth.passkey.factorCount",
  "DB",
  `SELECT
    (SELECT count(*) FROM passkey WHERE userId = ?1)
      + (SELECT count(*) FROM account WHERE userId = ?1 AND providerId <> 'credential') AS n`,
);

export const PASSKEY_FACTOR_STATE = sql(
  "auth.passkey.factorState",
  "DB",
  `SELECT
      (SELECT count(*) FROM passkey WHERE userId = ?1) AS passkeys,
      EXISTS(SELECT 1 FROM passkey WHERE id = ?3 AND userId = ?1) AS isPasskeyTarget,
      COALESCE(SUM(providerId <> 'credential'), 0) AS socialAccounts,
      COALESCE(MAX(providerId = 'credential'), 0) AS hasPassword,
      MAX(CASE WHEN id = ?2 THEN providerId END) AS targetProvider
    FROM account
    WHERE userId = ?1`,
);

export const PASSKEY_HAS_FACTOR = sql(
  "auth.passkey.hasFactor",
  "DB",
  `SELECT EXISTS(
      SELECT 1 FROM passkey WHERE userId = ?1
      UNION ALL
      SELECT 1 FROM account WHERE userId = ?1 AND providerId <> 'credential'
    ) AS hasFactor`,
);

export const PASSKEY_TRIM = sql(
  "auth.passkey.trimToNewest",
  "DB",
  `DELETE FROM passkey
    WHERE userId = ?1 AND id NOT IN (
      SELECT id FROM passkey
      WHERE userId = ?1
      ORDER BY createdAt DESC, rowid DESC
      LIMIT ?2
    )`,
);

export const SESSION_DELETE = sql("auth.session.delete", "DB", "DELETE FROM session WHERE id = ?");

export const SESSION_DELETE_FOR_USER = sql(
  "auth.session.deleteForUser",
  "DB",
  "DELETE FROM session WHERE userId = ?",
);

export const SESSION_DELETE_OTHERS = sql(
  "auth.session.deleteOthers",
  "DB",
  "DELETE FROM session WHERE userId = ? AND id <> ?",
);

export const SESSION_DELETE_OWN = sql(
  "auth.session.deleteOwn",
  "DB",
  "DELETE FROM session WHERE id = ? AND userId = ?",
);

export const SESSION_LIST_ACTIVE = sql(
  "auth.session.listActive",
  "DB",
  `SELECT id, userId, ipAddress, userAgent, asn, asOrganization, country, city,
           createdIp, createdAsn, createdAsOrganization, createdCountry, createdCity,
           lastActiveAt, signInProvider, twoFactorMethod, twoFactorVerifiedAt,
           createdAt, updatedAt, expiresAt
    FROM session
    WHERE userId = ? AND expiresAt > ?
    ORDER BY COALESCE(lastActiveAt, updatedAt) DESC, createdAt DESC
    LIMIT ?`,
);

export const SESSION_LIVE = sql(
  "auth.session.live",
  "DB",
  "SELECT id FROM session WHERE id IN (SELECT value FROM json_each(?)) AND expiresAt > ?",
);

export const SESSION_MARK_PASSKEY = sql(
  "auth.session.markPasskey",
  "DB",
  "UPDATE session SET signInProvider = 'passkey', twoFactorVerifiedAt = ? WHERE id = ?",
);

export const SESSION_TOUCH_ACTIVITY = sql(
  "auth.session.touchActivity",
  "DB",
  `UPDATE session
    SET lastActiveAt = ?,
        ipAddress = COALESCE(?, ipAddress),
        asn = COALESCE(?, asn),
        asOrganization = COALESCE(?, asOrganization),
        country = COALESCE(?, country),
        city = COALESCE(?, city)
    WHERE id = ?`,
);

export const SESSION_TRIM = sql(
  "auth.session.trimToNewest",
  "DB",
  `DELETE FROM session
    WHERE userId = ?1 AND id NOT IN (
      SELECT id FROM session
      WHERE userId = ?1
      ORDER BY COALESCE(lastActiveAt, updatedAt) DESC, createdAt DESC
      LIMIT ?2
    )`,
);

export const TRUSTED_DEVICE_DELETE_EXPIRED = sql(
  "auth.trustedDevice.deleteExpired",
  "DB",
  "DELETE FROM trusted_device WHERE user_id = ? AND expires_at <= ?",
);

export const TRUSTED_DEVICE_DELETE_FOR_USER = sql(
  "auth.trustedDevice.deleteForUser",
  "DB",
  "DELETE FROM trusted_device WHERE user_id = ?",
);

export const TRUSTED_DEVICE_DELETE_OWN = sql(
  "auth.trustedDevice.deleteOwn",
  "DB",
  "DELETE FROM trusted_device WHERE id = ? AND user_id = ? RETURNING token_hash",
);

export const TRUSTED_DEVICE_INSERT = sql(
  "auth.trustedDevice.insert",
  "DB",
  `INSERT INTO trusted_device (
      id, token_hash, user_id, user_agent, ip_address, asn, as_organization, country, city,
      created_ip, created_asn, created_as_organization, created_country, created_city,
      created_at, last_used_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

export const TRUSTED_DEVICE_LIST_ACTIVE = sql(
  "auth.trustedDevice.listActive",
  "DB",
  `SELECT id, token_hash, user_agent, ip_address, asn, as_organization, country, city,
           created_ip, created_asn, created_as_organization, created_country, created_city,
           created_at, last_used_at, expires_at
    FROM trusted_device
    WHERE user_id = ? AND expires_at > ?
    ORDER BY last_used_at DESC, created_at DESC`,
);

export const TRUSTED_DEVICE_MATCH = sql(
  "auth.trustedDevice.match",
  "DB",
  `SELECT td.id AS deviceId, td.last_used_at AS lastUsedAt, td.expires_at AS expiresAt,
           td.user_agent AS userAgent, td.ip_address AS ipAddress, td.asn AS asn,
           td.country AS country, td.created_country AS createdCountry,
           u.id AS userId, u.twoFactorEnabled AS twoFactorEnabled, u.banned AS banned
    FROM user u
    JOIN trusted_device td ON td.user_id = u.id
    WHERE u.email = ? COLLATE NOCASE AND td.token_hash = ? AND td.expires_at > ?`,
);

export const TRUSTED_DEVICE_ROTATE = sql(
  "auth.trustedDevice.rotate",
  "DB",
  `UPDATE trusted_device
    SET token_hash = ?,
        last_used_at = ?,
        user_agent = COALESCE(?, user_agent),
        ip_address = COALESCE(?, ip_address),
        asn = COALESCE(?, asn),
        as_organization = COALESCE(?, as_organization),
        country = COALESCE(?, country),
        city = COALESCE(?, city)
    WHERE id = ? AND token_hash = ?`,
);

export const TRUSTED_DEVICE_TRIM = sql(
  "auth.trustedDevice.trimToNewest",
  "DB",
  `DELETE FROM trusted_device
    WHERE user_id = ?1 AND id NOT IN (
      SELECT id FROM trusted_device
      WHERE user_id = ?1
      ORDER BY last_used_at DESC, created_at DESC
      LIMIT ?2
    )`,
);

export const TWO_FACTOR_DELETE_FOR_USER = sql(
  "auth.twoFactor.deleteForUser",
  "DB",
  "DELETE FROM twoFactor WHERE userId = ?",
);

export const USER_CLEAR_TWO_FACTOR_ENABLED_AT = sql(
  "auth.user.clearTwoFactorEnabledAt",
  "DB",
  "UPDATE user SET twoFactorEnabledAt = NULL WHERE id = ?",
);

export const USER_HAS_OTHER_SESSION_OR_DEVICE = sql(
  "auth.user.hasOtherSessionOrDevice",
  "DB",
  `SELECT
    EXISTS(
      SELECT 1 FROM session WHERE userId = ?1 AND id <> ?2 AND expiresAt > ?3
      UNION ALL
      SELECT 1 FROM trusted_device
      WHERE user_id = ?1 AND expires_at > ?4 AND (?7 IS NULL OR id <> ?7)
    ) AS hasPrior,
    EXISTS(
      SELECT 1 FROM session
      WHERE userId = ?1 AND id <> ?2 AND expiresAt > ?3
        AND (
          (COALESCE(asn, -1) = COALESCE(?5, -1) AND COALESCE(country, '') = COALESCE(?6, ''))
          OR (COALESCE(createdAsn, -1) = COALESCE(?5, -1) AND COALESCE(createdCountry, '') = COALESCE(?6, ''))
        )
      UNION ALL
      SELECT 1 FROM trusted_device
      WHERE user_id = ?1 AND expires_at > ?4 AND (?7 IS NULL OR id <> ?7)
        AND (
          (COALESCE(asn, -1) = COALESCE(?5, -1) AND COALESCE(country, '') = COALESCE(?6, ''))
          OR (COALESCE(created_asn, -1) = COALESCE(?5, -1) AND COALESCE(created_country, '') = COALESCE(?6, ''))
        )
    ) AS hasMatch`,
);

export const USER_ROLE = sql("auth.user.role", "DB", "SELECT role FROM user WHERE id = ?");

export const USER_SET_PASSWORD_CHANGED_AT = sql(
  "auth.user.setPasswordChangedAt",
  "DB",
  "UPDATE user SET passwordChangedAt = ? WHERE id = ?",
);

export const USER_SET_TWO_FACTOR_ENABLED_AT = sql(
  "auth.user.setTwoFactorEnabledAt",
  "DB",
  "UPDATE user SET twoFactorEnabledAt = ? WHERE id = ? AND twoFactorEnabledAt IS NULL",
);

export const VERIFICATION_DELETE = sql(
  "auth.verification.delete",
  "DB",
  "DELETE FROM verification WHERE identifier = ?",
);

export const VERIFICATION_DELETE_TRUST_BRIDGES = sql(
  "auth.verification.deleteTrustBridges",
  "DB",
  "DELETE FROM verification WHERE identifier GLOB 'trust-device-*' AND value = ?",
);

export const VERIFICATION_INSERT = sql(
  "auth.verification.insert",
  "DB",
  `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)`,
);

export const VERIFICATION_TAKE = sql(
  "auth.verification.take",
  "DB",
  "DELETE FROM verification WHERE identifier = ? RETURNING value, expiresAt",
);

export const VERIFICATION_TAKE_MATCHING = sql(
  "auth.verification.takeMatching",
  "DB",
  "DELETE FROM verification WHERE identifier = ? AND value = ? RETURNING expiresAt",
);
