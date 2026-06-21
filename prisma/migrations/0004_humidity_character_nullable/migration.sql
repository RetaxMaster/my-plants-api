-- Permissive indoor places: a place may omit its humidity character. The watering/viability
-- engines fall back to real outdoor weather (a real signal) when it is null, instead of forcing
-- a NORMAL default. Existing rows keep their current value; the column simply becomes nullable.
ALTER TABLE `places` MODIFY `humidity_character` ENUM('DRY', 'NORMAL', 'HUMID') NULL;
