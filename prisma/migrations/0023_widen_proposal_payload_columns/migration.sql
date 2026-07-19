-- Widen the proposal payload columns so the validated bound can never exceed the physical column.
--
-- `assertSerializedBound` accepts a payload of EXACTLY 64 KiB (65,536 bytes) — that boundary is
-- deliberate and boundary-tested. A MariaDB `TEXT` column holds at most 65,535 bytes. The two disagreed
-- by one byte, so a payload that passed every validator could still fail at INSERT, turning an
-- actionable 400 into a driver error the agent cannot act on.
--
-- Verified against the live schema (information_schema.COLUMNS): both columns reported
-- CHARACTER_OCTET_LENGTH = 65535.
--
-- MEDIUMTEXT holds 16 MiB, so the application-level 64 KiB bound stays the ONLY limit that can be hit —
-- which is what makes the validator's error the one the agent actually receives. `summary` is left as
-- TEXT: it is capped at 500 characters, three orders of magnitude below the column.
--
-- Safe on a populated database: MEDIUMTEXT is a widening of TEXT, so no value can be truncated and no
-- default or nullability changes. `doctor_write_proposals` is introduced by 0022 and is empty in every
-- environment at the time this runs.
ALTER TABLE `doctor_write_proposals`
    MODIFY `operations` MEDIUMTEXT NOT NULL,
    MODIFY `snapshot`   MEDIUMTEXT NOT NULL;
